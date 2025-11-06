// /api/v1-preview.mjs
// Modes :
//  - Preview (défaut)  → JSON { ok, mode:"preview", provider_url, width, height, seed }
//  - Proxy (Figma)     → proxy:true  → image/jpeg binaire (plus simple à afficher côté Figma)
//  - Save (persistant) → save:true   → télécharge + upload Supabase  → JSON { ok, image_url, meta }
//
// Notes clés :
//  - Previews : jamais stockées (on renvoie un provider_url direct pour <img src>)
//  - Save : toujours ré-hébergé sur Supabase (jamais d’URL provider dans la réponse)
//  - CORS compatible Figma (Origin:null) + OPTIONS
//  - NSFW : si provider renvoie une erreur JSON, on propage 502 avec code "pollinations_failed"
//  - Latence : px par défaut = 384 en fast:true ; on borne width/height 64..1024
//
// Dépendances internes : ../lib/http.mjs (setCORS) ; ../lib/supabase.mjs (getSupabaseServiceRole)

export const config = { runtime: "nodejs" };

import { randomUUID } from "crypto";
import { setCORS } from "../lib/http.mjs";
import {
  getSupabaseServiceRole,
  ensureSupabaseClient,
} from "../lib/supabase.mjs";

/* ---------- ENV ---------- */
const OUTPUT_PUBLIC       = (process.env.OUTPUT_PUBLIC || "true") === "true"; // public vs signed
const OUTPUT_SIGNED_TTL_S = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30);
const BUCKET_IMAGES       = process.env.BUCKET_IMAGES || "generated_images";   // ex: generated_images / outputs
const CACHE_CONTROL       = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);

// Provider base
const POL_URL  = "https://image.pollinations.ai/prompt";

// ---------- Utils ----------
const clamp = (n, min, max) => Math.max(min, Math.min(max, Math.floor(n || 0)));
const isTruthy = (v) => v === true || v === "true" || v === 1 || v === "1";
const today = () => new Date().toISOString().slice(0, 10);

// ratio helper : on traite px comme *côté le plus long*
function dimsFrom(ratio = "1:1", px = 384) {
  px = clamp(px, 128, 1024);
  if (ratio === "3:4") {
    // 3:4 → côté long = height
    const h = px;
    const w = Math.max(64, Math.round((3 / 4) * h));
    return { width: w, height: h };
  }
  // défaut carré 1:1
  return { width: px, height: px };
}

function pickExtFromContentType(ct) {
  if (!ct) return ".jpg";
  const v = String(ct).toLowerCase();
  if (v.includes("png"))  return ".png";
  if (v.includes("webp")) return ".webp";
  return ".jpg";
}

async function fetchWithTimeout(url, init, ms) {
  // Node 18+ : AbortSignal.timeout dispo
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(tid); }
}

/**
 * Construit un prompt à partir d’attributs si aucun prompt libre fourni.
 * Vocabulaire "safe" + esthétique "Instagram influencer".
 */
function buildPromptFromAttrs(b) {
  const {
    gender, background, outfit, skin_tone, hair_length, hair_color, eye_color,
    body_type, bust_size, butt_size, mood
  } = b || {};

  // Mappages explicites — formulations modestes/safe
  const genderTxt   = gender === "man" ? "man" : "woman";
  const bgMap       = { studio:"white studio background", office:"modern office background", city:"urban daylight background", nature:"outdoor nature background" };
  const hairLenMap  = { short:"short", medium:"medium-length", long:"long", bald:"bald" };
  const moodMap     = { neutral:"neutral", friendly:"friendly", confident:"confident", cool:"cool", serious:"serious", approachable:"approachable" };

  // On neutralise des mots "triggers"
  const outfitSafe = String(outfit || "tee")
    .replace(/fitted/gi, "crew-neck")
    .replace(/tank\s*top/gi, "sleeveless top");

  const parts = [
    "photorealistic portrait, instagram influencer aesthetic",
    `youthful adult (25–35) ${genderTxt}`,
    skin_tone ? `${skin_tone} skin` : null,
    body_type ? `${body_type} build` : null,
    hair_length ? `${hairLenMap[hair_length] || hair_length} ${hair_color || ""} hair`.trim() : (hair_color ? `${hair_color} hair` : null),
    eye_color ? `${eye_color} eyes` : null,
    `wearing ${outfitSafe}`,
    "balanced chest profile, fuller hips", // morpho lexicon safe
    mood ? `${moodMap[mood] || mood} look` : null,
    "looking at camera",
    bgMap[background || "studio"] || "white studio background",
    "soft beauty lighting, 85mm portrait look, shallow depth of field",
    "shoulders-up or waist-up, clean framing",
    "natural skin texture, studio-quality retouching",
    "no watermark, no text, no celebrity likeness"
  ].filter(Boolean);

  return parts.join(", ");
}

/**
 * Construit une URL GET "provider_url" (pour previews) – aucun appel côté serveur.
 */
function providerURL({ prompt, width, height, model = "flux", safe = true, fast = true, seed }) {
  const q = new URLSearchParams({
    model,
    width: String(clamp(width, 64, 1792)),
    height: String(clamp(height, 64, 1792)),
    // réglages "rapides"
    enhance: fast ? "false" : "true",
    nologo: "true",
    nofeed: "true",
    private: "true",
    safe: String(!!safe),
    quality: fast ? "medium" : "high",
    ...(Number.isFinite(seed) ? { seed: String(Math.floor(seed)) } : {}),
  }).toString();

  return `${POL_URL}/${encodeURIComponent(prompt)}?${q}`;
}

/**
 * Appel POST Pollinations (binaire direct). Utilisé pour proxy/save.
 * - Retourne { ok:true, buffer, contentType }
 * - Ou { ok:false, status, text, json }
 */
async function pollinationsPOST({ prompt, width, height, model = "flux", safe = true, fast = true, seed, timeoutMs = 15000 }) {
  const body = {
    prompt,
    width: clamp(width, 64, 1792),
    height: clamp(height, 64, 1792),
    model,
    // réglages vitesse/qualité
    enhance: fast ? false : true,
    nologo: true,
    nofeed: true,
    transparent: false,
    safe: !!safe,
    quality: fast ? "medium" : "high",
  };
  if (Number.isFinite(seed)) body.seed = Math.floor(seed);

  const res = await fetchWithTimeout(POL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Accept image de préférence (Pollinations renvoie l'image en direct)
      "Accept": "image/jpeg,image/png;q=0.9,*/*;q=0.8",
      "User-Agent": "Photoglow-Preview/1.0",
    },
    body: JSON.stringify(body),
  }, timeoutMs);

  const ctype = res.headers.get("content-type") || "";
  const isImage = /image\/(jpeg|jpg|png|webp)/i.test(ctype);

  if (res.ok && isImage) {
    const ab = await res.arrayBuffer();
    return { ok: true, buffer: Buffer.from(ab), contentType: ctype || "image/jpeg" };
  }

  // Erreur provider : on tente de lire du JSON textuel clair
  let payloadText = "";
  try { payloadText = await res.text(); } catch {}
  let json = null;
  try { json = JSON.parse(payloadText); } catch {}

  return { ok: false, status: res.status, text: payloadText, json, contentType: ctype };
}

/**
 * Upload Supabase (service role) vers BUCKET_IMAGES :
 * outputs/YYYY-MM-DD/{uuid}.<ext>
 */
async function uploadToSupabase(buffer, contentType) {
  const supabaseAdmin = getSupabaseServiceRole();
  ensureSupabaseClient(supabaseAdmin, "service");

  const keyBase = `outputs/${today()}/${randomUUID()}`;
  const ext = pickExtFromContentType(contentType);
  const key = `${keyBase}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET_IMAGES)
    .upload(key, buffer, {
      contentType,
      cacheControl: String(CACHE_CONTROL),
      upsert: false,
    });

  if (error) {
    throw new Error(`storage_upload_failed: ${error.message}`);
  }

  if (OUTPUT_PUBLIC) {
    const { data } = supabaseAdmin.storage.from(BUCKET_IMAGES).getPublicUrl(key);
    return data?.publicUrl || null;
  } else {
    const { data, error: signErr } = await supabaseAdmin.storage
      .from(BUCKET_IMAGES)
      .createSignedUrl(key, OUTPUT_SIGNED_TTL_S);
    if (signErr) throw new Error(`storage_signed_url_failed: ${signErr.message}`);
    return data?.signedUrl || null;
  }
}

// ---------- HTTP Handler ----------
export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    const b = typeof req.body === "object" && req.body ? req.body : {};
    const modeProxy = isTruthy(b.proxy);
    const doSave    = isTruthy(b.save);

    // Par défaut : previews rapides
    const fast = b.fast !== undefined ? isTruthy(b.fast) : true;
    const ratio = typeof b.ratio === "string" ? b.ratio : "1:1";
    const px    = clamp(b.px ?? (fast ? 384 : 512), 128, 1024);
    const safe  = b.safe !== undefined ? isTruthy(b.safe) : true;
    const seed  = Number.isFinite(b.seed) ? Math.floor(b.seed) : undefined;

    const { width, height } = dimsFrom(ratio, px);

    // Prompt : soit b.prompt, soit construit depuis attributs
    let prompt = typeof b.prompt === "string" && b.prompt.trim().length >= 3
      ? b.prompt.trim()
      : buildPromptFromAttrs(b);

    // -------- Mode SAVE (persistant → Supabase) --------
    if (doSave) {
      const r = await pollinationsPOST({ prompt, width, height, model: "flux", safe, fast, seed, timeoutMs: fast ? 15000 : 25000 });
      if (!r.ok) {
        return res.status(r.status || 502).json({
          ok: false,
          error: "pollinations_failed",
          details: r.json || r.text || "provider_error",
          hint: safe ? "if this is a false-positive NSFW, retry with safe:false or change outfit to tee" : undefined,
        });
      }
      try {
        const image_url = await uploadToSupabase(r.buffer, r.contentType || "image/jpeg");
        return res.status(200).json({
          ok: true,
          mode: "save",
          image_url,
          meta: { width, height, seed, ratio, fast, safe }
        });
      } catch (e) {
        return res.status(500).json({ ok: false, error: "storage_error", message: e?.message || String(e) });
      }
    }

    // -------- Mode PROXY (Figma → binaire image/jpeg) --------
    if (modeProxy) {
      const r = await pollinationsPOST({ prompt, width, height, model: "flux", safe, fast, seed, timeoutMs: fast ? 12000 : 20000 });
      if (!r.ok) {
        // IMPORTANT : on renvoie JSON (502) pour que Figma puisse décider de rejouer (safe:false/outfit)
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(r.status || 502).end(JSON.stringify({
          ok: false,
          error: "pollinations_failed",
          details: r.json || r.text || "provider_error",
          safe_was: !!safe,
          hint: "On error with safe:true, retry with safe:false or outfit:'tee'"
        }));
      }
      res.setHeader("Content-Type", r.contentType || "image/jpeg");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(200).end(r.buffer);
    }

    // -------- Mode PREVIEW (défaut) → JSON (pas de génération côté serveur) --------
    const provider_url = providerURL({ prompt, width, height, model: "flux", safe, fast, seed });
    return res.status(200).json({
      ok: true,
      mode: "preview",
      provider_url,
      width,
      height,
      seed,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error", message: e?.message || String(e) });
  }
}
