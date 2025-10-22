// /api/generate-batch.js
// Unifié multi-prompts + img2img/text2img, reupload Supabase, insert photos_meta

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

/** ---------- Config ---------- */
const ALLOWED_AR = new Set([
  "1:1","16:9","9:16","4:3","3:4","3:2","2:3","4:5","5:4","21:9","9:21","2:1","1:2"
]);

const DEFAULT_TEXT2IMG_MODEL = process.env.TEXT2IMG_MODEL || "black-forest-labs/flux-1.1-pro";
const DEFAULT_IMG2IMG_MODEL  = "black-forest-labs/flux-kontext-pro";

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const REPLICATE_TOKEN   = process.env.REPLICATE_API_TOKEN;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !REPLICATE_TOKEN) {
  console.warn("⚠️ Missing env vars. Required: SUPABASE_URL, SUPABASE_ANON_KEY, REPLICATE_API_TOKEN");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const replicate = new Replicate({ auth: REPLICATE_TOKEN });

/** ---------- Helpers ---------- */
function todayISODate() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normCategory(slug) {
  return (slug || "uncategorized").toString().trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

function ensureArrayPrompts(body) {
  if (Array.isArray(body.prompts) && body.prompts.length) return body.prompts.map(String);
  if (body.prompt) return [String(body.prompt)];
  return [];
}

/** Télécharge une URL (replicate.delivery) → Buffer */
async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download_failed_${r.status}`);
  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

/** Upload Buffer → Supabase public URL */
async function uploadToSupabasePublic(buffer, path) {
  const { error: upErr } = await supabase
    .storage.from("generated_images")
    .upload(path, buffer, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: false
    });
  if (upErr) throw upErr;

  const { data } = supabase.storage.from("generated_images").getPublicUrl(path);
  return data.publicUrl;
}

/** Insert meta row */
async function insertMeta(row) {
  // RLS: en proto, policy d'insert publique doit être active
  const { error } = await supabase.from("photos_meta").insert(row);
  if (error) {
    console.warn("⚠️ insert photos_meta failed:", error.message);
  }
}

/** Appel Replicate (retourne 1 URL d'image) */
async function callReplicateOnce({ mode, model, prompt, input_image, aspect_ratio }) {
  const t0 = Date.now();
  const input = mode === "img2img"
    ? { prompt, image: input_image } // flux-kontext-pro (img2img)
    : { prompt, aspect_ratio };      // flux-1.1-pro (text2img)

  console.log("🧪 [batch] Calling Replicate:", { model, input });

  // On utilise predictions.create pour rester compatible
  const prediction = await replicate.predictions.create({
    model,
    input
  });

  // Poll simple jusqu’au statut terminal
  let pred = prediction;
  while (pred.status === "starting" || pred.status === "processing" || pred.status === "queued") {
    await new Promise(r => setTimeout(r, 1000));
    pred = await replicate.predictions.get(pred.id);
  }

  if (pred.status !== "succeeded") {
    console.error("❌ Replicate failed:", { id: pred.id, status: pred.status, error: pred.error });
    throw new Error(`replicate_failed_${pred.status}`);
  }

  // pred.output peut être string ou array; on normalise
  const out = Array.isArray(pred.output) ? pred.output : [pred.output];
  const firstUrl = out.find(u => typeof u === "string") || null;
  const duration_ms = Date.now() - t0;

  if (!firstUrl) {
    throw new Error("no_output_url");
  }

  return { replicate_url: firstUrl, duration_ms, prediction_id: pred.id };
}

/** ---------- Handler ---------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const receivedAt = new Date().toISOString();
    const body = req.body || {};
    console.log("🧾 /api/generate-batch received:", body);

    // Inputs
    const prompts = ensureArrayPrompts(body);
    if (prompts.length === 0) {
      return res.status(400).json({ success: false, error: "Missing prompt(s)" });
    }

    const input_image = body.input_image ? String(body.input_image) : null;
    const source = body.source ? String(body.source) : "api";
    const category_slug = normCategory(body.category || "ai-headshots");
    const batch_id = randomUUID();

    // Mode + AR
    const mode = input_image ? "img2img" : "text2img";

    let aspect_ratio = body.aspect_ratio;
    if (mode === "img2img") {
      aspect_ratio = "match_input_image"; // forcé
    } else {
      if (!ALLOWED_AR.has(aspect_ratio)) {
        // défaut raisonnable
        aspect_ratio = "1:1";
      }
    }

    // Modèle
    const model = body.model
      || (mode === "img2img" ? DEFAULT_IMG2IMG_MODEL : DEFAULT_TEXT2IMG_MODEL);

    // num_outputs (cap 4) : on duplique les prompts si demandé
    let requested = Math.min(Math.max(parseInt(body.num_outputs || 1, 10), 1), 4);
    const worklist = [];
    for (const p of prompts) {
      for (let i = 0; i < requested; i++) worklist.push(p);
    }

    const dateSlug = todayISODate();
    const items = [];
    const started = Date.now();

    // Exécution en série (plus simple à débug; on parallélisera plus tard si besoin)
    for (const p of worklist) {
      try {
        const { replicate_url, duration_ms, prediction_id } = await callReplicateOnce({
          mode, model, prompt: p, input_image, aspect_ratio
        });

        // Download → Supabase
        const buf = await fetchAsBuffer(replicate_url);
        const fileId = randomUUID();
        const path = `categories/${category_slug}/outputs/${dateSlug}/${fileId}.jpg`;

        const publicUrl = await uploadToSupabasePublic(buf, path);

        // Meta row
        await insertMeta({
          created_at: receivedAt,
          prompt: p,
          category: category_slug,
          source,
          image_url: publicUrl,
          mode,
          batch_id,
          input_url: input_image,
          output_path: path,
          model,
          duration_ms
        });

        items.push({
          prompt: p,
          image_url: publicUrl,
          replicate_url,
          prediction_id,
          duration_ms
        });
      } catch (e) {
        console.error("❌ item_failed:", e?.message || e);
        items.push({
          prompt: p,
          error: String(e?.message || e)
        });
      }
    }

    const total_ms = Date.now() - started;

    return res.status(200).json({
      success: true,
      mode,
      category: category_slug,
      batch_id,
      count: items.filter(i => i.image_url).length,
      duration_ms: total_ms,
      items
    });
  } catch (err) {
    console.error("❌ /api/generate-batch error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || "internal_error" });
  }
}
