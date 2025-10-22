// /api/generate-batch.js
// Batch prompts + num_outputs en UNE prédiction par prompt
// Reupload Supabase + insertion photos_meta
// test_mode: bypass Replicate (placeholder JPEG) pour valider la pipeline sans crédit
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

/** Placeholder 1x1 JPEG (b64) pour test_mode */
const B64_JPEG_1x1 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEA8QDw8PDw8PDw8PDw8PDw8PDw8PFREWFhUR"
+ "GyggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGi0lHyUtLS0tLS0tLS0tLS0t"
+ "LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAX"
+ "AAADAQAAAAAAAAAAAAAAAAABAgME/8QAFxABAQEBAAAAAAAAAAAAAAAAAQIDAP/aAAwDAQACEQMR"
+ "AD8A4kYAAAAA//Z";

/** Télécharge une URL → Buffer */
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

/** Insert meta row (best-effort) */
async function insertMeta(row) {
  const { error } = await supabase.from("photos_meta").insert(row);
  if (error) console.warn("⚠️ insert photos_meta failed:", error.message);
}

/** Attente utilitaire */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Appel Replicate (ARRAY d'URLs) avec retry 429, stop clair sur 402 */
async function callReplicateOnce({ mode, model, prompt, input_image, aspect_ratio, num_outputs }) {
  const t0 = Date.now();
  const input = mode === "img2img"
    ? { prompt, image: input_image, num_outputs }
    : { prompt, aspect_ratio, num_outputs };

  console.log("🧪 [batch] Calling Replicate:", { model, input: { ...input, image: input.image ? "<redacted>" : undefined } });

  let attempt = 0;
  let pred;
  while (true) {
    try {
      pred = await replicate.predictions.create({ model, input });
      break;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("Payment Required") || msg.includes("Insufficient credit")) {
        // on remonte explicitement pour couper court
        const err = new Error("payment_required");
        err.code = 402;
        throw err;
      }
      if (msg.includes("Too Many Requests") && attempt < 1) {
        attempt++;
        const retryAfter = /retry_after\":\s*(\d+)/.exec(msg)?.[1];
        const wait = (parseInt(retryAfter || "10", 10) + 2) * 1000;
        console.warn(`⚠️ 429 from Replicate, retrying in ~${wait}ms...`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }

  // Polling
  while (pred.status === "starting" || pred.status === "processing" || pred.status === "queued") {
    await sleep(1000);
    pred = await replicate.predictions.get(pred.id);
  }

  if (pred.status !== "succeeded") {
    console.error("❌ Replicate failed:", { id: pred.id, status: pred.status, error: pred.error });
    throw new Error(`replicate_failed_${pred.status}`);
  }

  const outs = Array.isArray(pred.output) ? pred.output : [pred.output];
  const urls = outs.filter(u => typeof u === "string");
  const duration_ms = Date.now() - t0;

  if (!urls.length) throw new Error("no_output_url");
  return { replicate_urls: urls, duration_ms, prediction_id: pred.id };
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
    if (mode === "img2img") aspect_ratio = "match_input_image";
    else if (!ALLOWED_AR.has(aspect_ratio)) aspect_ratio = "1:1";

    // Modèle
    const model = body.model || (mode === "img2img" ? DEFAULT_IMG2IMG_MODEL : DEFAULT_TEXT2IMG_MODEL);
    // num_outputs par prompt (1..4)
    const num_outputs = Math.min(Math.max(parseInt(body.num_outputs || 1, 10), 1), 4);

    const dateSlug = todayISODate();
    const items = [];
    const started = Date.now();

    // ----- TEST MODE: bypass Replicate -----
    if (body.test_mode === true) {
      for (const p of prompts) {
        for (let i = 0; i < num_outputs; i++) {
          const buf = Buffer.from(B64_JPEG_1x1, "base64");
          const fileId = randomUUID();
          const path = `categories/${category_slug}/outputs/${dateSlug}/${fileId}.jpg`;
          const publicUrl = await uploadToSupabasePublic(buf, path);

          await insertMeta({
            created_at: receivedAt,
            prompt: p,
            category: category_slug,
            source,
            image_url: publicUrl,
            mode: `${mode}-test`,
            batch_id,
            input_url: input_image,
            output_path: path,
            model: "test-placeholder",
            duration_ms: 1
          });

          items.push({
            prompt: p,
            image_url: publicUrl,
            replicate_url: null,
            prediction_id: "test-mode",
            duration_ms: 1
          });
        }
      }

      const total_ms = Date.now() - started;
      return res.status(200).json({
        success: true,
        mode: `${mode}-test`,
        category: category_slug,
        batch_id,
        count: items.length,
        duration_ms: total_ms,
        items
      });
    }
    // ----- FIN TEST MODE -----

    // Production: un appel Replicate PAR prompt, avec num_outputs
    for (const p of prompts) {
      try {
        const { replicate_urls, duration_ms, prediction_id } = await callReplicateOnce({
          mode, model, prompt: p, input_image, aspect_ratio, num_outputs
        });

        for (const rUrl of replicate_urls) {
          const buf = await fetchAsBuffer(rUrl);
          const fileId = randomUUID();
          const path = `categories/${category_slug}/outputs/${dateSlug}/${fileId}.jpg`;
          const publicUrl = await uploadToSupabasePublic(buf, path);

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
            replicate_url: rUrl,
            prediction_id,
            duration_ms
          });
        }
      } catch (e) {
        // Si 402, on remonte l’info proprement et on arrête (inutile de continuer)
        if (e?.code === 402 || String(e?.message).includes("payment_required")) {
          console.warn("⚠️ payment_required: stop batch early");
          return res.status(402).json({
            success: false,
            error: "payment_required",
            message: "Replicate credits required. Add a payment method and credit, then retry.",
            mode, category: category_slug, batch_id, items
          });
        }
        console.error("❌ item_failed:", e?.message || e);
        items.push({ prompt: p, error: String(e?.message || e) });
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
