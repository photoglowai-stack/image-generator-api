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

async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download_failed_${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function uploadToSupabasePublic(buffer, path) {
  const { error } = await supabase
    .storage.from("generated_images")
    .upload(path, buffer, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from("generated_images").getPublicUrl(path);
  return data.publicUrl;
}
async function insertMeta(row) {
  const { error } = await supabase.from("photos_meta").insert(row);
  if (error) console.warn("⚠️ insert photos_meta failed:", error.message);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callReplicateOnce({ mode, model, prompt, input_image, aspect_ratio, num_outputs, negative_prompt, seed }) {
  const t0 = Date.now();
  const base = { prompt, num_outputs };
  const input =
    mode === "img2img"
      ? { ...base, image: input_image, ...(seed ? { seed } : {}), ...(negative_prompt ? { negative_prompt } : {}) }
      : { ...base, aspect_ratio, ...(seed ? { seed } : {}), ...(negative_prompt ? { negative_prompt } : {}) };

  console.log("🧪 [batch] Calling Replicate:", { model, input: { ...input, image: input.image ? "<redacted>" : undefined } });

  let attempt = 0, pred;
  while (true) {
    try {
      pred = await replicate.predictions.create({ model, input });
      break;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("Payment Required") || msg.includes("Insufficient credit")) {
        const err = new Error("payment_required"); err.code = 402; throw err;
      }
      if (msg.includes("Too Many Requests") && attempt < 1) {
        attempt++; const retryAfter = /retry_after\":\s*(\d+)/.exec(msg)?.[1];
        const wait = (parseInt(retryAfter || "10", 10) + 2) * 1000;
        console.warn(`⚠️ 429 from Replicate, retrying in ~${wait}ms...`); await sleep(wait); continue;
      }
      throw e;
    }
  }
  while (["starting","processing","queued"].includes(pred.status)) {
    await sleep(1000); pred = await replicate.predictions.get(pred.id);
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
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const receivedAt = new Date().toISOString();
    const body = req.body || {};
    console.log("🧾 /api/generate-batch received:", body);

    const prompts = ensureArrayPrompts(body);
    if (prompts.length === 0) return res.status(400).json({ success: false, error: "Missing prompt(s)" });

    // Inputs A/B/C (seule A utilisée par img2img Flux; B/C conservées en meta)
    const input_image   = body.input_image   ? String(body.input_image)   : null;
    const input_image_b = body.input_image_b ? String(body.input_image_b) : null;
    const input_image_c = body.input_image_c ? String(body.input_image_c) : null;

    const source = body.source ? String(body.source) : "api";
    const category_slug = normCategory(body.category || "ai-headshots");
    const batch_id = randomUUID();

    // Mode + AR
    const mode = input_image ? "img2img" : "text2img";
    let aspect_ratio = body.aspect_ratio;
    if (mode === "img2img") aspect_ratio = "match_input_image";
    else if (!ALLOWED_AR.has(aspect_ratio)) aspect_ratio = "1:1";

    const model = body.model || (mode === "img2img" ? DEFAULT_IMG2IMG_MODEL : DEFAULT_TEXT2IMG_MODEL);
    const num_outputs = Math.min(Math.max(parseInt(body.num_outputs || 1, 10), 1), 4);
    const negative_prompt = body.negative_prompt || undefined;
    const seed = body.seed || undefined;

    const dateSlug = todayISODate();
    const items = [];
    const started = Date.now();

    // TEST MODE
    if (body.test_mode === true) {
      for (const p of prompts) {
        for (let i = 0; i < num_outputs; i++) {
          const buf = Buffer.from(B64_JPEG_1x1, "base64");
          const fileId = randomUUID();
          const path = `categories/${category_slug}/outputs/${dateSlug}/${fileId}.jpg`;
          const publicUrl = await uploadToSupabasePublic(buf, path);
          await insertMeta({
            created_at: receivedAt, prompt: p, category: category_slug, source,
            image_url: publicUrl, mode: `${mode}-test`, batch_id,
            input_url: input_image, input_url_b: input_image_b, input_url_c: input_image_c,
            output_path: path, model: "test-placeholder", duration_ms: 1,
            negative_prompt: negative_prompt || null, seed: seed || null
          });
          items.push({ prompt: p, image_url: publicUrl, replicate_url: null, prediction_id: "test-mode", duration_ms: 1, ar: aspect_ratio });
        }
      }
      return res.status(200).json({
        success: true, mode: `${mode}-test`, category: category_slug, batch_id,
        count: items.length, duration_ms: Date.now() - started, items
      });
    }

    // PROD
    for (const p of prompts) {
      try {
        const { replicate_urls, duration_ms, prediction_id } = await callReplicateOnce({
          mode, model, prompt: p, input_image, aspect_ratio, num_outputs, negative_prompt, seed
        });
        for (const rUrl of replicate_urls) {
          const buf = await fetchAsBuffer(rUrl);
          const fileId = randomUUID();
          const path = `categories/${category_slug}/outputs/${dateSlug}/${fileId}.jpg`;
          const publicUrl = await uploadToSupabasePublic(buf, path);
          await insertMeta({
            created_at: receivedAt, prompt: p, category: category_slug, source,
            image_url: publicUrl, mode, batch_id,
            input_url: input_image, input_url_b: input_image_b, input_url_c: input_image_c,
            output_path: path, model, duration_ms, negative_prompt: negative_prompt || null, seed: seed || null
          });
          items.push({ prompt: p, image_url: publicUrl, replicate_url: rUrl, prediction_id, duration_ms, ar: aspect_ratio });
        }
      } catch (e) {
        if (e?.code === 402 || String(e?.message).includes("payment_required")) {
          console.warn("⚠️ payment_required: stop batch early");
          return res.status(402).json({
            success: false, error: "payment_required",
            message: "Replicate credits required. Add a payment method and credit, then retry.",
            mode, category: category_slug, batch_id, items
          });
        }
        console.error("❌ item_failed:", e?.message || e);
        items.push({ prompt: p, error: String(e?.message || e) });
      }
    }
    return res.status(200).json({
      success: true, mode, category: category_slug, batch_id,
      count: items.filter(i => i.image_url).length,
      duration_ms: Date.now() - started, items
    });
  } catch (err) {
    console.error("❌ /api/generate-batch error:", err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || "internal_error" });
  }
}
