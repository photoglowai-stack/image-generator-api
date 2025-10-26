// /api/generate-gen4-image.mjs — Générateur unifié (Flux T2I, Flux Kontext I2I, Runway Gen-4)
// • T2I: flux-1.1-pro ; I2I: flux-kontext-pro (input_image, aspect_ratio: "match_input_image")
// • Gen4/Gen4-Turbo: reference_images[1..3], reference_tags
// • CORS Figma (Origin:null), idempotency, crédits (best-effort), upload Supabase, photos_meta
// • Retour: toujours URL Supabase (durable), jamais l’URL provider

export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// ---------- CORS ----------
function setCORS(req, res) {
  const allowNull = (process.env.ALLOW_NULL_ORIGIN || "true") === "true";
  const reqOrigin = req.headers?.origin;
  const front = process.env.FRONT_ORIGIN || "*";
  const allowOrigin =
    allowNull && (reqOrigin === "null" || reqOrigin === null) ? "null" : front;

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
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Buckets / tables
const BUCKET_IMAGES  = process.env.BUCKET_IMAGES  || "generated_images";
const BUCKET_UPLOADS = process.env.BUCKET_UPLOADS || "photos";
const TABLE_META     = process.env.TABLE_META     || "photos_meta";

// Whitelist buckets + anti cross-tenant
const ALLOWED_REFERENCE_BUCKETS = (process.env.ALLOWED_REFERENCE_BUCKETS || BUCKET_UPLOADS)
  .split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_REFERENCE_BUCKET = ALLOWED_REFERENCE_BUCKETS[0] || BUCKET_UPLOADS;
const UPLOAD_OBJECT_PREFIX = process.env.UPLOAD_OBJECT_PREFIX || "uploads";

// Sortie publique ou signée
const OUTPUT_PUBLIC       = (process.env.OUTPUT_PUBLIC || "true") === "true";
const OUTPUT_SIGNED_TTL_S = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7);
const UPLOAD_SIGNED_TTL_S = Number(process.env.UPLOAD_SIGNED_TTL_S || 60 * 15);

// Modèles
const FLUX_T2I_MODEL = "black-forest-labs/flux-1.1-pro";
const FLUX_I2I_MODEL = process.env.FLUX_I2I_MODEL || "black-forest-labs/flux-kontext-pro";
const MODEL_MAP = {
  flux: FLUX_T2I_MODEL,
  gen4: "runwayml/gen4-image",
  "gen4-turbo": "runwayml/gen4-image-turbo"
};
const RUNWAY_AR = new Set(["1:1", "16:9", "9:16", "3:2", "2:3", "4:5", "5:4"]);

// ---------- Clients ----------
const supabaseAuth = (SUPABASE_URL && ANON_KEY)
  ? createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  : null;

const supabaseAdmin = (SUPABASE_URL && SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPrediction(replicate, id, timeoutMs = 25000, intervalMs = 1200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await replicate.predictions.get(id);
    if (!p) break;
    if (p.status === "succeeded" || p.status === "failed" || p.status === "canceled") return p;
    await sleep(intervalMs);
  }
  return await replicate.predictions.get(id);
}

function pickExtFromContentType(ct) {
  if (!ct) return ".jpg";
  const v = String(ct).toLowerCase();
  if (v.includes("png"))  return ".png";
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

function normalizeAspectRatio(model, requested) {
  const fallback = "1:1";
  if (typeof requested !== "string" || requested.trim() === "") return fallback;
  const trimmed = requested.trim();
  if (model === "gen4" || model === "gen4-turbo") {
    return RUNWAY_AR.has(trimmed) ? trimmed : fallback;
  }
  return trimmed;
}

function normalizeSeed(seed) {
  if (seed === null || seed === undefined) return undefined;
  const parsed = typeof seed === "string" ? Number.parseInt(seed, 10) : Number(seed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function normalizeGuidanceValue(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// 0–1 or 0–100
function normalizeStrength(v) {
  if (v === null || v === undefined || v === "") return 0.6;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  if (!Number.isFinite(n)) return 0.6;
  const z = n > 1 ? n / 100 : n;
  const c = Math.max(0, Math.min(z, 1));
  return c <= 0.01 ? 0.6 : c;
}

async function uploadOutput(buffer, contentType, userId) {
  const filename = `outputs/${userId}/${new Date().toISOString().slice(0,10)}/${randomUUID()}`;
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
  const fn = op === "debit" ? "debit_credits" : "credit_credits";
  try {
    const { error } = await supabaseAdmin.rpc(fn, { p_user_id: user_id, p_amount: amount });
    if (error && !/does not exist|not found/i.test(error.message)) throw error;
  } catch { /* noop */ }
}

async function insertPhotosMeta(row) {
  try { await supabaseAdmin.from(TABLE_META).insert(row); }
  catch (e) { console.error("photos_meta insert failed:", e?.message || e); }
}

// 1x1 PNG transparent (test_mode)
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO4B2E0AAAAASUVORK5CYII=";

// --- Références : http(s), supabase://, storage://, ou chemin brut ---
function collectRefs({ reference_images, image_urls, image_url, image, images }) {
  const refs = []
    .concat(Array.isArray(reference_images) ? reference_images : [])
    .concat(Array.isArray(image_urls)       ? image_urls       : [])
    .concat(typeof image_url === "string"   ? [image_url]      : [])
    .concat(typeof image === "string"       ? [image]          : [])
    .concat(Array.isArray(images)           ? images           : []);

  return refs
    .map((v) => {
      if (typeof v !== "string") return null;
      const t = v.trim();
      if (!t) return null;
      if (/^https?:\/\//i.test(t))   return { kind: "http",    value: t };
      if (/^supabase:\/\//i.test(t)) return { kind: "storage", value: t.slice("supabase://".length) };
      if (/^storage:\/\//i.test(t))  return { kind: "storage", value: t.slice("storage://".length) };
      if (/^data:/i.test(t))         return null; // ignoré
      return { kind: "storage", value: t };
    })
    .filter(Boolean)
    .slice(0, 3);
}

// ---- Normalisation chemin + anti cross-tenant ----
function normalizeStoragePath(rawPath) {
  const cleaned = String(rawPath || "").replace(/\\+/g, "/").replace(/^\/+/, "").trim();
  if (!cleaned) return null;
  const segments = cleaned.split("/");
  const safeSegments = [];
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return null;
    const sanitized = segment
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!sanitized) return null;
    safeSegments.push(sanitized);
  }
  return safeSegments.join("/");
}

function extractStorageTarget(rawValue, userId) {
  if (typeof rawValue !== "string") return null;
  const cleaned = rawValue.replace(/^\/+/, "").trim();
  if (!cleaned) return null;

  const match = cleaned.match(/^([A-Za-z0-9_-]+)\/(.+)$/);
  let bucket = DEFAULT_REFERENCE_BUCKET;
  let path = cleaned;

  if (match) {
    const [, candidateBucket, rest] = match;
    const allowed = new Set(ALLOWED_REFERENCE_BUCKETS.length ? ALLOWED_REFERENCE_BUCKETS : [DEFAULT_REFERENCE_BUCKET]);
    if (!allowed.has(candidateBucket)) return null;
    bucket = candidateBucket;
    path = rest;
  }

  const normalizedPath = normalizeStoragePath(path);
  if (!normalizedPath) return null;

  if (bucket === BUCKET_UPLOADS) {
    const required = `${UPLOAD_OBJECT_PREFIX}/${userId}/`;
    if (!normalizedPath.startsWith(required)) return null;
  }

  return { bucket, path: normalizedPath };
}

async function resolveStorageReference(entry, userId) {
  if (!supabaseAdmin) return null;
  const target = extractStorageTarget(entry.value, userId);
  if (!target) return null;
  const { bucket, path } = target;
  try {
    const storage = supabaseAdmin.storage.from(bucket);
    const { data, error } = await storage.createSignedUrl(path, UPLOAD_SIGNED_TTL_S);
    if (!error && data?.signedUrl) return data.signedUrl;
    const { data: pub } = storage.getPublicUrl(path);
    return pub?.publicUrl || null;
  } catch (err) {
    console.warn("storage_reference_resolution_failed", err?.message || err);
    return null;
  }
}

async function resolveReferenceUrls(entries, userId) {
  const out = [];
  for (const e of entries) {
    if (e.kind === "http") out.push(e.value);
    else if (e.kind === "storage") {
      const u = await resolveStorageReference(e, userId);
      if (u) out.push(u);
    }
  }
  return out;
}

// ---------- HANDLER ----------
export default async function handler(req, res) {
  setCORS(req, res);
  if (req.method === "OPTIONS" || req.method === "HEAD") return res.status(204).end();

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
        OUTPUT_PUBLIC
      }
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!supabaseAuth || !supabaseAdmin) return res.status(500).json({ error: "missing_env_supabase" });

  try {
    // Auth (Bearer Supabase user)
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing_bearer_token" });

    const { data: userData, error: authErr } = await supabaseAuth.auth.getUser(token);
    if (authErr || !userData?.user) return res.status(401).json({ error: "invalid_token" });
    const user_id = userData.user.id;

    // Payload
    const {
      mode = "text2img",
      model = "flux",
      model_path, // override optionnel
      prompt_final,
      prompt,
      negative_prompt, // Flux T2I uniquement
      image_url,
      image_urls,
      image,
      images,
      reference_images,
      reference_tags,
      prompt_strength,
      aspect_ratio = "1:1",
      seed,
      guidance,
      test_mode = false,
      extra = {},
      source = "figma-admin"
    } = req.body || {};

    if (!["text2img", "img2img"].includes(mode)) {
      return res.status(422).json({ error: "invalid_mode" });
    }
    const promptText = prompt_final || prompt || "";
    if (mode === "text2img" && !promptText) {
      return res.status(400).json({ error: "missing_prompt" });
    }
    const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"] || null;

    // test_mode (pas d'appel provider)
    if (test_mode === true) {
      const jobId = `test_${Date.now()}_${randomUUID()}`;
      const buf = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
      const url = await uploadOutput(buf, "image/png", user_id);
      const normalizedAspect = normalizeAspectRatio(model, aspect_ratio);

      await insertPhotosMeta({
        user_id, mode, model: "test_mode_dummy",
        prompt: promptText || "(test)",
        aspect_ratio: normalizedAspect, image_url: url, source,
        created_at: new Date().toISOString()
      });

      return res.status(200).json({
        ok: true, job_id: jobId, mode, model: "test_mode_dummy",
        image_url: url, test_mode: true, idempotency_key: idempotencyKey
      });
    }

    // Import dynamique de Replicate (évite les 500 non-JSON en cas d'échec)
    let Replicate;
    try {
      ({ default: Replicate } = await import("replicate"));
    } catch (e) {
      return res.status(500).json({ error: "replicate_import_failed", details: String(e?.message || e) });
    }
    const replicate = REPLICATE_API_TOKEN ? new Replicate({ auth: REPLICATE_API_TOKEN }) : null;
    if (!replicate) return res.status(500).json({ error: "missing_env_replicate" });

    // Crédit: pré-débit (best-effort)
    await safeDebitCredit({ user_id, amount: 1, op: "debit" });

    // Params communs
    let finalModelPath = model_path || MODEL_MAP[model] || model;
    const normalizedAspect = normalizeAspectRatio(model, aspect_ratio);
    const normalizedSeed   = normalizeSeed(seed);
    const guidanceValue    = normalizeGuidanceValue(guidance);

    const input = { prompt: promptText, aspect_ratio: normalizedAspect, ...extra };
    if (normalizedSeed !== undefined) input.seed = normalizedSeed;

    // Références
    const refEntries   = collectRefs({ reference_images, image_urls, image_url, image, images });
    const resolvedRefs = await resolveReferenceUrls(refEntries, user_id);

    // Sélection Flux I2I vs T2I
    if (model === "flux") {
      const hasRef = resolvedRefs.length > 0;
      const wantsI2I = (mode === "img2img") || (hasRef && mode === "text2img");
      finalModelPath = wantsI2I ? FLUX_I2I_MODEL : FLUX_T2I_MODEL;
    }

    // Branching par modèle
    if (finalModelPath.includes("runwayml/gen4-image")) {
      // Gen-4
      if (mode === "img2img" && resolvedRefs.length === 0) {
        await safeDebitCredit({ user_id, amount: 1, op: "credit" });
        return res.status(400).json({ error: "missing_reference_images" });
      }
      if (finalModelPath.includes("turbo") && resolvedRefs.length === 0) {
        await safeDebitCredit({ user_id, amount: 1, op: "credit" });
        return res.status(400).json({ error: "gen4_turbo_requires_reference_image" });
      }
      if (resolvedRefs.length > 0) {
        input.reference_images = resolvedRefs.slice(0, 3);
        if (Array.isArray(reference_tags) && reference_tags.length > 0) {
          input.reference_tags = reference_tags
            .filter((t) => typeof t === "string" && /^[A-Za-z][A-Za-z0-9]{2,14}$/.test(t))
            .slice(0, input.reference_images.length);
        }
      }
      if (guidanceValue !== undefined) input.cfg_scale = guidanceValue;
      delete input.prompt_strength;
      delete input.image;
      delete input.image_url;

    } else if (finalModelPath.includes("black-forest-labs/flux-kontext")) {
      // Flux Kontext (I2I)
      const first = resolvedRefs[0];
      if (!first) {
        await safeDebitCredit({ user_id, amount: 1, op: "credit" });
        return res.status(400).json({ error: "missing_image_url" });
      }
      input.input_image = first;
      input.aspect_ratio = "match_input_image";
      delete input.image;
      delete input.image_url;
      delete input.prompt_strength;
      if ("negative_prompt" in input) delete input.negative_prompt;
      if (guidanceValue !== undefined) input.guidance_scale = guidanceValue;

    } else if (finalModelPath.includes("black-forest-labs/flux-1.1-pro")) {
      // Flux T2I
      if (negative_prompt) input.negative_prompt = negative_prompt;
      if (guidanceValue !== undefined) input.guidance_scale = guidanceValue;
      delete input.image;
      delete input.image_url;
      delete input.prompt_strength;

    } else {
      // Autres
      if (mode === "img2img") {
        const first = resolvedRefs[0];
        if (!first) {
          await safeDebitCredit({ user_id, amount: 1, op: "credit" });
          return res.status(400).json({ error: "missing_image_url" });
        }
        input.image = first;
        input.image_url = first;
      }
      if (guidanceValue !== undefined) input.guidance_scale = guidanceValue;
      if (negative_prompt && !("negative_prompt" in input)) input.negative_prompt = negative_prompt;
    }

    // Appel provider
    let created;
    try {
      created = await replicate.predictions.create({ model: finalModelPath, input });
    } catch (err) {
      await safeDebitCredit({ user_id, amount: 1, op: "credit" });
      const msg = String(err?.message || err);
      const tag = /401|unauthorized|auth/i.test(msg) ? "replicate_auth_error" : "replicate_model_error";
      return res.status(500).json({ error: tag, details: msg });
    }

    const prediction = await waitForPrediction(replicate, created.id);
    if (!prediction || prediction.status !== "succeeded") {
      await safeDebitCredit({ user_id, amount: 1, op: "credit" });
      return res.status(500).json({
        error: "prediction_failed",
        details: prediction?.error || prediction?.status || "unknown"
      });
    }

    // Upload sortie → Supabase
    const out = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!out) {
      await safeDebitCredit({ user_id, amount: 1, op: "credit" });
      return res.status(500).json({ error: "no_output_from_model" });
    }
    const { buf, ct } = await downloadBuffer(out);
    const publicOrSignedUrl = await uploadOutput(buf, ct, user_id);

    // Meta DB (non bloquant)
    await insertPhotosMeta({
      user_id,
      mode,
      model: finalModelPath,
      prompt: promptText,
      aspect_ratio: input.aspect_ratio,
      seed: normalizedSeed,
      image_url: publicOrSignedUrl,
      source,
      created_at: new Date().toISOString()
    });

    // Réponse
    return res.status(200).json({
      ok: true,
      job_id: prediction.id,
      mode,
      model: finalModelPath,
      image_url: publicOrSignedUrl,
      debug: { has_refs: resolvedRefs.length },
      test_mode: false,
      idempotency_key: idempotencyKey
    });
  } catch (e) {
    return res.status(500).json({
      error: "FUNCTION_INVOCATION_FAILED",
      details: String(e?.message || e)
    });
  }
}
