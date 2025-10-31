// /api/v1-preview.mjs — Commercial Photoreal Preview (V4)
// 🧯 Self-contained CORS (no http.mjs)
// 🔐 Cold-start safe: dynamic import of supabase.mjs inside POST only
// ✅ GET health-check (200) even with missing ENV
// ✅ Robust body parsing (string → JSON), prompt fallback if missing
// ✅ Compact commercial prompt (≤ ~180–200 chars), SFW, photoreal
// ✅ Deterministic variations (framing/lens/light) from seed
// ✅ Versioned cache key (STYLE_VERSION) + seed + size
// ✅ FAST MODE: set body.fast=true (or "1") → smaller size ⇒ faster
// ✅ Pollinations: nologo=true, private=true, enhance=false, negative=anti-cartoon
// ✅ Fallback timeout when AbortSignal.timeout is unavailable

export const config = { runtime: "nodejs" };

/* ---------- CORS (inline) ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ---------- ENV ---------- */
const POL_TOKEN       = process.env.POLLINATIONS_TOKEN || "";
const BUCKET          = process.env.PREVIEW_BUCKET || "generated_images";
const OUTPUT_PUBLIC   = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S    = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7);
const CACHE_CONTROL   = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);
const DEFAULT_SEED    = Number(process.env.PREVIEW_SEED || 777);
const PREVIEW_ENHANCE = (process.env.PREVIEW_ENHANCE ?? "false") === "true";
const PREVIEW_NEGATIVE =
  process.env.PREVIEW_NEGATIVE ||
  "cartoon, illustration, anime, cgi, 3d render, doll, mannequin, plastic skin, waxy skin, over-smooth, unrealistic, deformed, extra fingers, watermark, text, logo, lowres";

/* ---------- Helpers ---------- */
const ok = (v) => typeof v === "string" && v.trim().length > 0;
const clamp = (v, arr, d = 0) => (ok(v) && arr.includes(v) ? v : arr[d]);
const toBool = (v) => v === true || v === "true" || v === "1" || v === 1;

const BG = ["studio","office","city","nature"];
const OUTFIT = ["blazer","shirt","tee","athleisure"];
const MOOD = ["warm","neutral","cool"];
const RATIO = ["1:1","3:4"];
const SKIN = ["light","fair","medium","tan","deep"];
const HAIR_COLOR = ["black","brown","blonde","red","gray"];
const HAIR_LEN = ["short","medium","long","bald"];
const EYE = ["brown","blue","green","hazel","gray"];
const BODY = ["slim","athletic","average","curvy","muscular"];

const SIZE_HQ = { "1:1": [896, 896], "3:4": [896, 1152] };
const SIZE_FAST = { "1:1": [640, 640], "3:4": [672, 896] };
const STYLE_VERSION = "commercial_photo_v2";

/* ---------- Deterministic variations ---------- */
const hash = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
};
const pick = (arr, h) => arr[h % arr.length];

/* ---------- Prompt Builder ---------- */
function buildPrompt(form) {
  const gender = clamp(form?.gender, ["woman","man"], 0);
  const bgKey  = clamp(form?.background, BG, 0);
  const outfitKey = clamp(form?.outfit, OUTFIT, 1);
  const skin   = clamp(form?.skin_tone ?? form?.skinTone ?? form?.skin, SKIN, 2);
  const hairC  = clamp(form?.hair_color ?? form?.hairColor ?? form?.hair, HAIR_COLOR, 1);
  const hairL  = clamp(form?.hair_length ?? form?.hairLength ?? form?.hairLen, HAIR_LEN, 2);
  const eyes   = clamp(form?.eye_color ?? form?.eyeColor ?? form?.eyes, EYE, 0);

  const BG_MAP = {
    studio: "white studio background",
    office: "office background",
    city:   "city background",
    nature: "nature background",
  };
  const OUTFIT_W = { blazer:"tailored blazer", shirt:"fitted top", tee:"crew-neck tee", athleisure:"athleisure top" };
  const OUTFIT_M = { blazer:"tailored blazer", shirt:"fitted shirt", tee:"crew-neck tee", athleisure:"athletic tee" };
  const outfit = gender === "woman" ? OUTFIT_W[outfitKey] : OUTFIT_M[outfitKey];
  const hairPhrase = hairL === "bald" ? "bald" : `${hairL} ${hairC} hair`;

  const FRAMING = ["portrait","close-up portrait","headshot"];
  const LENSES  = ["85mm f/1.8","50mm f/1.4","135mm f/2"];
  const LIGHTS  = ["soft beauty lighting","natural window light","studio lighting"];
  const seedStr = String(form?.seed ?? `${gender}|${bgKey}|${outfitKey}|${skin}|${hairC}|${hairL}|${eyes}`);
  const h = hash(seedStr);
  const framing  = pick(FRAMING, h);
  const lens     = pick(LENSES,  h >> 4);
  const lighting = pick(LIGHTS,  h >> 8);

  const parts = [
    `professional ${framing} of ${gender === "woman" ? "woman" : "man"}`,
    BG_MAP[bgKey],
    outfit,
    hairPhrase,
    `${skin} skin`,
    `${eyes} eyes`,
    lens,
    lighting,
    gender === "woman" ? "natural makeup" : "neat grooming",
    "photorealistic",
    "commercial"
  ];

  let prompt = parts.join(", ");
  if (prompt.length > 200) prompt = parts.filter(p => !["natural makeup","neat grooming"].includes(p)).join(", ");
  if (prompt.length > 200) prompt = parts.filter(p => p !== lens).join(", ");
  return prompt;
}

/* ---------- Timeout helper ---------- */
async function fetchWithTimeout(url, init, ms) {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal)
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET")     return res.status(200).json({ ok:true, ready:true, endpoint:"/api/v1-preview" });
  if (req.method !== "POST")    return res.status(405).json({ ok:false, error:"method_not_allowed" });

  // ✅ CORRECT IMPORT PATH
  let ensureSupabaseClient, getSupabaseServiceRole, sb;
  try {
    ({ ensureSupabaseClient, getSupabaseServiceRole } = await import("../lib/supabase.mjs"));
  } catch (e) {
    return res.status(500).json({ ok:false, error:"supabase_module_load_failed", details: String(e).slice(0,200) });
  }

  try {
    try { sb = getSupabaseServiceRole(); }
    catch { return res.status(500).json({ ok:false, error:"missing_env_supabase" }); }
    ensureSupabaseClient(sb, "service");

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const form = (body && typeof body === "object") ? body : {};
    if (!ok(form?.prompt)) form.prompt = buildPrompt(form);

    const fast = toBool(form?.fast);
    const ratio = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO, 0);
    const [W, H] = (fast ? SIZE_FAST : SIZE_HQ)[ratio] || (fast ? [640,640] : [896,896]);
    const seed = Number.isFinite(Number(form?.seed)) ? Math.floor(Number(form.seed)) : DEFAULT_SEED;
    const prompt = String(form.prompt);
    const key = `${STYLE_VERSION}${fast ? "|fast" : ""}|${prompt}|seed:${seed}|${W}x${H}`;

    const cached = await sb.from("preview_cache").select("image_url,hits").eq("key", key).maybeSingle();
    if (cached.data?.image_url) {
      await sb.from("preview_cache").update({ hits: (cached.data.hits||0)+1 }).eq("key", key).catch(()=>{});
      return res.status(200).json({ ok:true, image_url: cached.data.image_url, provider:"cache", seed, key, fast: !!fast });
    }

    const q = new URLSearchParams({
      model: "flux",
      width: String(W),
      height: String(H),
      seed: String(seed),
      private: "true",
      enhance: PREVIEW_ENHANCE ? "true" : "false",
      nologo: "true",
      negative: PREVIEW_NEGATIVE
    }).toString();
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`;
    const headers = POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {};

    const r = await fetchWithTimeout(url, { headers }, fast ? 30_000 : 60_000);
    if (!r.ok) {
      const msg = await r.text().catch(()=> "");
      return res.status(r.status).json({ ok:false, error:"pollinations_failed", details: msg.slice(0,400) });
    }
    const bytes = Buffer.from(await r.arrayBuffer());

    const { data: pub } = await sb.storage.getBucket(BUCKET);
    if (!pub) return res.status(500).json({ ok:false, error:"bucket_not_found", bucket: BUCKET });

    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth()+1).padStart(2,'0');
    const dd = String(d.getUTCDate()).padStart(2,'0');
    const path = `previews/${yyyy}-${mm}-${dd}/${encodeURIComponent(key)}.jpg`;

    const up = await sb.storage.from(BUCKET).upload(path, bytes, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: CACHE_CONTROL,
    });
    if (up.error) return res.status(500).json({ ok:false, error:"upload_failed", details: String(up.error).slice(0,200) });

    let imageUrl;
    if (OUTPUT_PUBLIC) {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      imageUrl = data.publicUrl;
    } else {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_S);
      if (error) return res.status(500).json({ ok:false, error:"signed_url_failed", details: String(error).slice(0,200) });
      imageUrl = data.signedUrl;
    }

    await sb.from("preview_cache").insert({ key, image_url: imageUrl }).catch(()=>{});
    return res.status(200).json({ ok:true, image_url: imageUrl, provider:"pollinations", seed, key, fast: !!fast });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"server_error", details: String(e).slice(0,400) });
  }
}
