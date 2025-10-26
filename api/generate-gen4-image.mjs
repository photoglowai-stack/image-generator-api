// /api/generate-gen4-image.mjs — Générateur unifié (Flux 1.1 Pro & Runway Gen-4)
// • Modes: text2img | img2img
// • Modèles: flux | gen4 | gen4-turbo  (surcharge possible via model_path)
// • CORS Figma (Origin:null), idempotency, crédits, upload Supabase, insertion photos_meta
// • Retour: URL Supabase (publique ou signée), jamais l’URL provider
// • Runtime Node.js (Vercel): pas d’images en réponse (JSON léger)

export const config = { runtime: "nodejs" };

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// ---------- CORS ----------
function setCORS(req, res) {
  const allowNull = (process.env.ALLOW_NULL_ORIGIN || "true") === "true";
  const reqOrigin = req.headers?.origin;
  const front = process.env.FRONT_ORIGIN || "*";
  const allowOrigin =
    allowNull && (reqOrigin === "null" || reqOrigin === null)
      ? "null"
      : front;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, idempotency-key, x-admin-token"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ---------- ENV ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Buckets / tables — valeurs par défaut sûres
const BUCKET_IMAGES = process.env.BUCKET_IMAGES || "generated_images"; // sorties
const TABLE_META = process.env.TABLE_META || "photos_meta";

// Sortie publique ou privée (signed URL)
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC || "true") === "true";
const OUTPUT_SIGNED_TTL_S = Number(
  process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7
); // 7 jours

// ---------- Clients ----------
const supabaseAuth =
  SUPABASE_URL && ANON_KEY
    ? createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    : null;

const supabaseAdmin =
  SUPABASE_URL && SERVICE_ROLE
    ? createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false },
      })
    : null;

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

// ---------- Modèles ----------
const MODEL_MAP = {
  flux: "black-forest-labs/flux-1.1-pro",
  gen4: "runwayml/gen4-image",
  "gen4-turbo": "runwayml/gen4-image-turbo",
};

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPrediction(id, timeoutMs = 25000, intervalMs = 1200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await replicate.predictions.get(id);
    if (!p) break;
    if (["succeeded", "failed", "canceled"].includes(p.status)) return p;
    await sleep(intervalMs);
  }
  return await replicate.predictions.get(id);
}

function pickExtFromContentType(ct) {
  if (!ct) return ".jpg";
  const v = ct.toLowerCase();
  if (v.includes("png")) return ".png";
  if (v.includes("webp")) return ".webp";
  if (v.includes("jpeg") || v.includes("jpg")) return ".jpg";
  return ".jpg";
}

async function downloadBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download_failed status=${r.status}`);
  const ct = r.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, ct, ext: pickExtFromContentType(ct) };
}

async function uploadOutput(buffer, contentType, userId) {
  const filename = `outputs/${userId}/${new Date()
    .toISOString()
    .slice(0, 10)}/${randomUUID()}`;
  const key = `${filename}${pickExtFromContentType(contentType)}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET_IMAGES)
    .upload(key, buffer, { contentType, upsert: false });
  if (error) throw new Error(`upload_failed: ${error.message}`);

  if (OUTPUT_PUBLIC) {
    const { data } = supabaseAdmin.storage.from(BUCKET_IMAGES).getPublicUrl(key);
    return data?.publicUrl || null;
  } else {
    const { data, error: signErr } = await supabaseAdmin.storage
      .from(BUCKET_IMAGES)
      .createSignedUrl(key, OUTPUT_SIGNED_TTL_S);
    if (signErr) throw new Error(`signed_url_failed: ${signErr.message}`);
    return data?.signedUrl || null;
  }
}

async function safeDebitCredit({ user_id, amount = 1, op = "debit" }) {
  // RPC facultatives : on “best-effort”, et on ne bloque pas si absent
  const fn = op === "debit" ? "debit_credits" : "credit_credits";
  try {
    const { error } = await supabaseAdmin.rpc(fn, {
      p_user_id: user_id,
      p_amount: amount,
    });
    if (error && !/does not exist|not found/i.test(error.message)) {
      throw error;
    }
  } catch {
    /* ignore in minimal setups */
  }
}

async function insertPhotosMeta(row) {
  try {
    await supabaseAdmin.from(TABLE_META).insert(row);
  } catch (e) {
    // n’empêche pas le succès ; log côté Vercel
    console.error("photos_meta insert failed:", e?.message || e);
  }
}

// 1x1 PNG transparent pour test_mode (aucun appel provider)
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO4B2E0AAAAASUVORK5CYII=";

// --- helpers refs ---
function collectHttpRefs({
  reference_images,
  reference_tags,
  image_urls,
  image_url,
  image,
  images,
}) {
  const refs =
    (Array.isArray(reference_images) ? reference_images : [])
      .concat(Array.isArray(image_urls) ? image_urls : [])
      .concat(typeof image_url === "string" ? [image_url] : [])
      .concat(typeof image === "string" ? [image] : [])
      .concat(Array.isArray(images) ? images : []);

  const httpRefs = refs
    .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
    .slice(0, 3);

  // Tags : valides si alphanum, commencent par lettre, 3–15 chars
  const validTags = Array.isArray(reference_tags)
    ? reference_tags
        .filter(
          (t) => typeof t === "string" && /^[A-Za-z][A-Za-z0-9]{2,14}$/.test(t)
        )
        .slice(0, httpRefs.length)
    : [];

  return { httpRefs, validTags };
}

// ---------- HANDLER ----------
export default async function handler(req, res) {
  setCORS(req, res);
  if (req.method === "OPTIONS" || req.method === "HEAD")
    return res.status(204).end();

  // Health
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      endpoint: "generate-unified",
      has_env: {
        SUPABASE_URL: !!SUPABASE_URL,
        SERVICE_ROLE: !!SERVICE_ROLE,
        ANON_KEY: !!ANON_KEY,
        REPLICATE_API_TOKEN: !!REPLICATE_API_TOKEN,
        BUCKET_IMAGES,
        TABLE_META,
        OUTPUT_PUBLIC,
      },
    });
  }

  if (req.method !== "POST")
    return res.status(405).json({ error: "method_not_allowed" });
  if (!supabaseAuth || !supabaseAdmin)
    return res.status(500).json({ error: "missing_env_supabase" });
  if (!replicate) return res.status(500).json({ error: "missing_env_replicate" });

  try {
    // ---- Auth: Bearer Supabase JWT ----
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing_bearer_token" });

    const { data: userData, error: authErr } =
      await supabaseAuth.auth.getUser(token);
    if (authErr || !userData?.user)
      return res.status(401).json({ error: "invalid_token" });
    const user_id = userData.user.id;

    // ---- Payload ----
    const {
      // “mode” et “model” pilotent tout :
      mode = "text2img", // "text2img" | "img2img"
      model = "flux", // "flux" | "gen4" | "gen4-turbo"
      model_path, // surclassement direct (optionnel)
      // prompts
      prompt_final,
      prompt, // compat legacy
      negative_prompt, // pris en charge pour FLUX
      // images & refs
      image_url,
      image_urls, // alias
      image, // alias string
      images, // alias array
      reference_images,
      reference_tags,
      prompt_strength, // 0.0–1.0 (Flux)
      // divers
      aspect_ratio = "1:1",
      seed,
      guidance,
      test_mode = false,
      extra = {},
      source = "figma-admin",
    } = req.body || {};

    if (!["text2img", "img2img"].includes(mode)) {
      return res.status(422).json({ error: "invalid_mode" });
    }
    const promptText = prompt_final || prompt || "";
    if (mode === "text2img" && !promptText) {
      return res.status(400).json({ error: "missing_prompt" });
    }

    const idempotencyKey =
      req.headers["idempotency-key"] || req.headers["Idempotency-Key"] || null;

    // ---- test_mode: bypass sans appel provider ----
    if (test_mode === true) {
      const jobId = `test_${Date.now()}_${randomUUID()}`;
      const buf = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
      const url = await uploadOutput(buf, "image/png", user_id);

      await insertPhotosMeta({
        user_id,
        mode,
        model: "test_mode_dummy",
        prompt: promptText || "(test)",
        aspect_ratio,
        image_url: url,
        source,
        created_at: new Date().toISOString(),
      });

      return res.status(200).json({
        ok: true,
        job_id: jobId,
        mode,
        model: "test_mode_dummy",
        image_url: url,
        test_mode: true,
        idempotency_key: idempotencyKey,
      });
    }

    // ---- Crédit: pré-débit (best-effort) ----
    await safeDebitCredit({ user_id, amount: 1, op: "debit" });

    // ---- Choix modèle & inputs communs ----
    const modelPath = model_path || MODEL_MAP[model] || model; // accepte slug explicite
    const input = {
      prompt: promptText,
      aspect_ratio,
      seed,
      guidance,
      ...extra,
    };

    // ----- Normalisation des références -----
    const { httpRefs, validTags } = collectHttpRefs({
      reference_images,
      reference_tags,
      image_urls,
      image_url,
      image,
      images,
    });

    // ----- Négatif : supporté par FLUX uniquement -----
    if (negative_prompt && model === "flux") {
      input.negative_prompt = negative_prompt;
    }

    // ----- Branching par modèle / mode -----
    if (model === "gen4" || model === "gen4-turbo") {
      // Gen-4 & Turbo : utilisent reference_images (+ reference_tags optionnels)
      if (mode === "img2img" && httpRefs.length === 0) {
        // En img2img, au moins 1 ref est nécessaire
        await safeDebitCredit({ user_id, amount: 1, op: "credit" });
        return res.status(400).json({ error: "missing_reference_images" });
      }
      if (model === "gen4-turbo" && httpRefs.length === 0) {
        // Turbo : exige au moins 1 référence au global
        await safeDebitCredit({ user_id, amount: 1, op: "credit" });
        return res
          .status(400)
          .json({ error: "gen4_turbo_requires_reference_image" });
      }
      if (httpRefs.length > 0) {
        input.reference_images = httpRefs.slice(0, 3);
        if (validTags.length > 0) {
          input.reference_tags = validTags.slice(0, input.reference_images.length);
        }
      }
      // Pas de prompt_strength côté Runway
      if ("prompt_strength" in input) delete input.prompt_strength;
      // Ne PAS renseigner input.image/_url pour Runway refs
      if ("image" in input) delete input.image;
      if ("image_url" in input) delete input.image_url;
    } else if (model === "flux") {
      // FLUX : img2img classique = image unique
      if (mode === "img2img") {
        const first = httpRefs[0];
        if (!first) {
          await safeDebitCredit({ user_id, amount: 1, op: "credit" });
          return res.status(400).json({ error: "missing_image_url" });
        }
        input.image = first;
        input.image_url = first;
        const effectiveStrength =
          typeof prompt_strength === "number" ? prompt_strength : 0.6;
        input.prompt_strength = effectiveStrength;
      }
      // (text2img Flux : rien de plus)
    } else {
      // Modèle inconnu : tentative générique
      if (mode === "img2img") {
        const first = httpRefs[0];
        if (first) {
          input.image = first;
          input.image_url = first;
        } else {
          await safeDebitCredit({ user_id, amount: 1, op: "credit" });
          return res.status(400).json({ error: "missing_image_url" });
        }
      }
    }

    // ---- Appel Replicate ----
    let created;
    try {
      created = await replicate.predictions.create({ model: modelPath, input });
    } catch (err) {
      // rollback crédit
      await safeDebitCredit({ user_id, amount: 1, op: "credit" });
      const msg = String(err?.message || err);
      const tag = /401|unauthorized|auth/i.test(msg)
        ? "replicate_auth_error"
        : "replicate_model_error";
      return res.status(500).json({ error: tag, details: msg });
    }

    const prediction = await waitForPrediction(created.id);
    if (!prediction || prediction.status !== "succeeded") {
      await safeDebitCredit({ user_id, amount: 1, op: "credit" });
      return res.status(500).json({
        error: "prediction_failed",
        details: prediction?.error || prediction?.status || "unknown",
      });
    }

    // ---- Récupération de la sortie (URL provider -> buffer) ----
    const out = Array.isArray(prediction.output)
      ? prediction.output[0]
      : prediction.output;
    if (!out) {
      await safeDebitCredit({ user_id, amount: 1, op: "credit" });
      return res.status(500).json({ error: "no_output_from_model" });
    }

    const { buf, ct } = await downloadBuffer(out);

    // ---- Upload durable Supabase ----
    const publicOrSignedUrl = await uploadOutput(buf, ct, user_id);

    // ---- Meta DB (non bloquant) ----
    await insertPhotosMeta({
      user_id,
      mode,
      model: modelPath,
      prompt: promptText,
      aspect_ratio,
      seed,
      image_url: publicOrSignedUrl,
      source,
      created_at: new Date().toISOString(),
    });

    // ---- Réponse finale (pas d’URL provider éphémère) ----
    return res.status(200).json({
      ok: true,
      job_id: prediction.id,
      mode,
      model: modelPath,
      image_url: publicOrSignedUrl,
      test_mode: false,
      idempotency_key: idempotencyKey,
    });
  } catch (e) {
    return res.status(500).json({
      error: "FUNCTION_INVOCATION_FAILED",
      details: String(e?.message || e),
    });
  }
}
