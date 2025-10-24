// /api/generate-gen4-image.js
// Alias: /v1/jobs (mappé dans vercel.json)
// POST /v1/jobs  { mode, model, prompt?, image_url?, aspect_ratio?, test_mode?, extra? }
//   - mode: "text2img" | "img2img" (default: text2img)
//   - model: "gen4" | "flux" | chemin complet Replicate (default: gen4)
// GET  /v1/jobs  → healthcheck simple

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// ---------- CORS ----------
function setCORS(res) {
  const origin = process.env.FRONT_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, idempotency-key, x-admin-token"
  );
}

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY;
const BUCKET        = process.env.BUCKET_IMAGES || "photos";
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Clients Supabase (auth public vs admin)
const supabaseAuth = (SUPABASE_URL && ANON_KEY)
  ? createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  : null;
const supabaseAdmin = (SUPABASE_URL && SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

const replicate = REPLICATE_API_TOKEN ? new Replicate({ auth: REPLICATE_API_TOKEN }) : null;

const MODEL_MAP = {
  gen4: "runwayml/gen4-image",
  flux: "black-forest-labs/flux-1.1-pro"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Poll Replicate jusqu'à "succeeded" (timeout ~25s)
async function waitForPrediction(id, timeoutMs = 25000, intervalMs = 1250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pred = await replicate.predictions.get(id);
    if (pred?.status === "succeeded" || pred?.status === "failed" || pred?.status === "canceled") {
      return pred;
    }
    await sleep(intervalMs);
  }
  return await replicate.predictions.get(id);
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "HEAD")    return res.status(204).end();

  // GET = health
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      endpoint: "jobs",
      has_env: {
        SUPABASE_URL: !!SUPABASE_URL,
        SERVICE_ROLE: !!SERVICE_ROLE,
        ANON_KEY: !!ANON_KEY,
        REPLICATE_API_TOKEN: !!REPLICATE_API_TOKEN,
        BUCKET: BUCKET
      }
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!supabaseAuth || !supabaseAdmin || !replicate) {
    return res.status(500).json({ error: "missing_env" });
  }

  try {
    // ---- Auth Bearer (JWT Supabase) ----
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing_bearer_token" });

    const { data: userData, error: authErr } = await supabaseAuth.auth.getUser(token);
    if (authErr || !userData?.user) return res.status(401).json({ error: "invalid_token" });
    const user_id = userData.user.id;

    // ---- Payload ----
    const idem = (req.headers["idempotency-key"] || req.headers["Idempotency-Key"] || null)?.toString() || null;
    const {
      mode = "text2img",
      model = "gen4",
      model_path,                 // facultatif: chemin complet Replicate
      prompt = "",
      image_url = "",
      aspect_ratio = "1:1",
      test_mode = false,
      extra = {}
    } = req.body || {};

    if (!["text2img", "img2img"].includes(mode)) {
      return res.status(422).json({ error: "invalid_mode" });
    }
    if (mode === "text2img" && !prompt) {
      return res.status(400).json({ error: "missing_prompt" });
    }
    if (mode === "img2img" && !image_url) {
      return res.status(400).json({ error: "missing_image_url" });
    }

    // ---- Crédits : pré-débit si pas en test ----
    let debited = false;
    if (!test_mode) {
      const { error: debitErr } = await supabaseAdmin.rpc("debit_credits", {
        p_user_id: user_id, p_amount: 1
      });
      if (debitErr) {
        if (String(debitErr.message).includes("insufficient_credits") ||
            String(debitErr.message).includes("no_credits_row")) {
          return res.status(402).json({ error: "insufficient_credits" });
        }
        return res.status(500).json({ error: "debit_failed", details: debitErr.message });
      }
      debited = true;
    }

    // ---- Choix du modèle ----
    const modelPath = model_path || MODEL_MAP[model] || model;

    // ---- Input modèle ----
    const input = { prompt, aspect_ratio, ...extra };
    if (mode === "img2img") {
      input.image = image_url;
      input.image_url = image_url;
    }

    // ---- Appel Replicate (création + attente) ----
    let created;
    try {
      created = await replicate.predictions.create({ model: modelPath, input });
    } catch (err) {
      if (debited) await supabaseAdmin.rpc("credit_credits", { p_user_id: user_id, p_amount: 1 });
      const msg = String(err?.message || err);
      const tag = /401|unauthorized|auth/i.test(msg) ? "replicate_auth_error" : "replicate_model_error";
      return res.status(500).json({ error: tag, details: msg });
    }

    const prediction = await waitForPrediction(created.id);
    if (prediction?.status !== "succeeded") {
      if (debited) await supabaseAdmin.rpc("credit_credits", { p_user_id: user_id, p_amount: 1 });
      return res.status(500).json({
        error: "prediction_failed",
        details: prediction?.error || prediction?.status || "unknown"
      });
    }

    const output = prediction?.output;
    const rawUrl = Array.isArray(output) ? output[0] : (output?.[0] || output);
    if (!rawUrl) {
      if (debited) await supabaseAdmin.rpc("credit_credits", { p_user_id: user_id, p_amount: 1 });
      return res.status(500).json({ error: "no_output_from_model" });
    }

    // ---- Upload Storage Supabase ----
    const resp = await fetch(rawUrl);
    if (!resp.ok) {
      if (debited) await supabaseAdmin.rpc("credit_credits", { p_user_id: user_id, p_amount: 1 });
      return res.status(500).json({ error: "download_failed", details: `status ${resp.status}` });
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = `gen/${user_id}/${Date.now()}_${randomUUID()}.jpg`; // <- robuste

    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(filename, buffer, { contentType: "image/jpeg", upsert: false });

    if (upErr) {
      if (debited) await supabaseAdmin.rpc("credit_credits", { p_user_id: user_id, p_amount: 1 });
      return res.status(500).json({ error: "upload_failed", details: upErr.message });
    }

    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(filename);

    return res.status(200).json({
      ok: true,
      job_id: prediction.id,
      user_id,
      model: modelPath,
      mode,
      image_url: pub?.publicUrl || null,
      source_url: rawUrl,
      test_mode,
      idempotency_key: idem
    });
  } catch (e) {
    return res.status(500).json({
      error: "FUNCTION_INVOCATION_FAILED",
      details: String(e?.message || e)
    });
  }
}
