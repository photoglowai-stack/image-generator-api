// /api/generate-gen4-image.mjs  — version complète patchée pour Figma / Vercel / Flux / Gen-4
// - Gère prompt_final, negative_prompt, preset_id/version, guidance, prompt_strength, seed
// - Supporte Origin:null (Figma)
// - Renvoie toujours l’URL Supabase finale + meta complète
// - Test_mode possible sans débit

export const config = { runtime: "nodejs" };

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// ---------- CORS ----------
function setCORS(req, res) {
  const reqOrigin = req.headers?.origin || "";
  const allowNull = process.env.ALLOW_NULL_ORIGIN === "true";
  const allowOrigin =
    allowNull && reqOrigin === "null"
      ? "null"
      : process.env.FRONT_ORIGIN || "*";

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
const BUCKET = process.env.BUCKET_IMAGES || "generated_images";
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

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
  gen4: "runwayml/gen4-image",
  flux: "black-forest-labs/flux-1.1-pro",
};

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPrediction(id, timeoutMs = 25000, intervalMs = 1250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await replicate.predictions.get(id);
    if (
      p?.status === "succeeded" ||
      p?.status === "failed" ||
      p?.status === "canceled"
    )
      return p;
    await sleep(intervalMs);
  }
  return await replicate.predictions.get(id);
}

// 1x1 PNG transparent (base64) — pour test_mode (pas d’appel Replicate)
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO4B2E0AAAAASUVORK5CYII=";

function pickExtFromContentType(ct) {
  if (!ct) return ".jpg";
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  return ".jpg";
}

// ---------- HANDLER ----------
export default async function handler(req, res) {
  setCORS(req, res);
  if (req.method === "OPTIONS" || req.method === "HEAD")
    return res.status(204).end();

  // GET = health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      endpoint: "generate-gen4-image",
      has_env: {
        SUPABASE_URL: !!SUPABASE_URL,
        SERVICE_ROLE: !!SERVICE_ROLE,
        ANON_KEY: !!ANON_KEY,
        REPLICATE_API_TOKEN: !!REPLICATE_API_TOKEN,
        BUCKET,
      },
    });
  }

  if (req.method !== "POST")
    return res.status(405).json({ error: "method_not_allowed" });
  if (!supabaseAuth || !supabaseAdmin)
    return res.status(500).json({ error: "missing_env_supabase" });

  try {
    // ---- Auth Bearer (JWT Supabase) ----
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing_bearer_token" });

    const { data: userData, error: authErr } =
      await supabaseAuth.auth.getUser(token);
    if (authErr || !userData?.user)
      return res.status(401).json({ error: "invalid_token" });
    const user_id = userData.user.id;

    // ---- Payload ----
    const idemHeader =
      req.headers["idempotency-key"] ||
      req.headers["Idempotency-Key"] ||
      null;
    const idempotencyKey = idemHeader ? String(idemHeader) : null;

    const {
      mode = "text2img",
      model = "gen4",
      model_path,
      prompt_final,
      prompt, // compat legacy
      negative_prompt,
      preset_id,
      preset_version,
      image_url = "",
      aspect_ratio = "1:1",
      guidance,
      prompt_strength,
      seed,
      test_mode = false,
      extra = {},
    } = req.body || {};

    if (!["text2img", "img2img"].includes(mode)) {
      return res.status(422).json({ error: "invalid_mode" });
    }
    if (mode === "text2img" && !prompt_final && !prompt) {
      return res.status(400).json({ error: "missing_prompt" });
    }
    if (mode === "img2img" && !image_url) {
      return res.status(400).json({ error: "missing_image_url" });
    }

    const promptText = prompt_final || prompt || "";
    const mergedExtra = {
      ...extra,
      guidance,
      prompt_strength,
      seed,
      preset_id,
      preset_version,
    };

    // -------------------------------
    // BYPASS TEST MODE
    // -------------------------------
    if (test_mode === true) {
      const jobId = `test_${Date.now()}_${randomUUID()}`;
      const buffer = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
      const filename = `gen/${user_id}/${jobId}.png`;

      const { error: upErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(filename, buffer, {
          contentType: "image/png",
          upsert: false,
        });

      if (upErr)
        return res
          .status(500)
          .json({ error: "upload_failed", details: upErr.message });

      const { data: pub } = supabaseAdmin.storage
        .from(BUCKET)
        .getPublicUrl(filename);

      return res.status(200).json({
        ok: true,
        job_id: jobId,
        user_id,
        model: "test_mode_dummy",
        mode,
        image_url: pub?.publicUrl || null,
        source_url: null,
        test_mode: true,
        idempotency_key: idempotencyKey,
      });
    }

    // ---- Replicate requis en prod réelle ----
    if (!replicate)
      return res.status(500).json({ error: "missing_env_replicate" });

    // ---- Crédits : pré-débit ----
    let debited = false;
    {
      const { error: debitErr } = await supabaseAdmin.rpc("debit_credits", {
        p_user_id: user_id,
        p_amount: 1,
      });
      if (debitErr) {
        const msg = String(debitErr.message || "");
        if (
          msg.includes("insufficient_credits") ||
          msg.includes("no_credits_row")
        ) {
          return res.status(402).json({ error: "insufficient_credits" });
        }
        return res.status(500).json({ error: "debit_failed", details: msg });
      }
      debited = true;
    }

    // ---- Choix du modèle & input ----
    const modelPath = model_path || MODEL_MAP[model] || model;
    const input = { prompt: promptText, aspect_ratio, ...mergedExtra };

    // Support du negative_prompt uniquement pour FLUX
    if (negative_prompt && model === "flux") {
      input.negative_prompt = negative_prompt;
    }

    if (mode === "img2img") {
      input.image = image_url;
      input.image_url = image_url;
      if (prompt_strength) input.prompt_strength = prompt_strength;
    }

    // ---- Appel Replicate ----
    let created;
    try {
      created = await replicate.predictions.create({
        model: modelPath,
        input,
      });
    } catch (err) {
      if (debited)
        await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id,
          p_amount: 1,
        });
      const msg = String(err?.message || err);
      const tag = /401|unauthorized|auth/i.test(msg)
        ? "replicate_auth_error"
        : "replicate_model_error";
      return res.status(500).json({ error: tag, details: msg });
    }

    const prediction = await waitForPrediction(created.id);
    if (prediction?.status !== "succeeded") {
      if (debited)
        await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id,
          p_amount: 1,
        });
      return res.status(500).json({
        error: "prediction_failed",
        details: prediction?.error || prediction?.status || "unknown",
      });
    }

    const output = prediction?.output;
    const rawUrl = Array.isArray(output)
      ? output[0]
      : output?.[0] || output;
    if (!rawUrl) {
      if (debited)
        await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id,
          p_amount: 1,
        });
      return res
        .status(500)
        .json({ error: "no_output_from_model" });
    }

    // ---- Télécharger et enregistrer dans Supabase Storage ----
    const resp = await fetch(rawUrl);
    if (!resp.ok) {
      if (debited)
        await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id,
          p_amount: 1,
        });
      return res
        .status(500)
        .json({ error: "download_failed", details: `status ${resp.status}` });
    }

    const arrBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrBuf);
    const ct = resp.headers.get("content-type") || "image/jpeg";
    const ext = pickExtFromContentType(ct);
    const filename = `gen/${user_id}/${Date.now()}_${randomUUID()}${ext}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(filename, buffer, { contentType: ct, upsert: false });

    if (upErr) {
      if (debited)
        await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id,
          p_amount: 1,
        });
      return res
        .status(500)
        .json({ error: "upload_failed", details: upErr.message });
    }

    const { data: pub } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(filename);

    return res.status(200).json({
      ok: true,
      job_id: prediction.id,
      user_id,
      model: modelPath,
      mode,
      image_url: pub?.publicUrl || null,
      source_url: rawUrl,
      test_mode: false,
      idempotency_key: idempotencyKey,
      meta: {
        prompt_final: promptText,
        prompt_negative: negative_prompt || null,
        preset_id: preset_id || null,
        preset_version: preset_version || null,
        guidance: guidance ?? null,
        prompt_strength: prompt_strength ?? null,
        seed: seed ?? null,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "FUNCTION_INVOCATION_FAILED",
      details: String(e?.message || e),
    });
  }
}
