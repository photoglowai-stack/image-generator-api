// /api/generate-gen4-image.js
// text2img Runway Gen4 Image → rehost Supabase + insert photos_meta

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // 👈 temporairement ouvert (à restreindre ensuite)
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ⚙️ Clients
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// 1x1 JPEG pour test_mode
const B64_JPEG_1x1 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEA8QDw8PDw8PDw8PDw8PDw8PDw8PFREWFhUR" +
  "GyggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGi0lHyUtLS0tLS0tLS0tLS0t" +
  "LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAX" +
  "AAADAQAAAAAAAAAAAAAAAAABAgME/8QAFxABAQEBAAAAAAAAAAAAAAAAAQIDAP/aAAwDAQACEQMR" +
  "AD8A4kYAAAAA//Z";

function todayISODate() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download_failed_${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadToSupabasePublic(buffer, path) {
  const { error } = await supabase.storage
    .from("generated_images")
    .upload(path, buffer, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: false,
    });
  if (error) throw error;

  const { data } = supabase.storage.from("generated_images").getPublicUrl(path);
  return data.publicUrl;
}

async function insertMeta(row) {
  const { error } = await supabase.from("photos_meta").insert(row);
  if (error) console.warn("⚠️ insert photos_meta failed:", error.message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method !== "POST")
      return res.status(405).json({ success: false, error: "Method not allowed" });

    const {
      prompt,
      aspect_ratio = "16:9",
      num_outputs = 1,
      source = "api-gen4",
      test_mode = false,
      category = "ai-headshots",
    } = req.body || {};

    if (!prompt && !test_mode)
      return res.status(400).json({ success: false, error: "Missing prompt" });

    const dateSlug = todayISODate();
    const batch_id = randomUUID();
    const receivedAt = new Date().toISOString();
    const started = Date.now();
    const items = [];

    // 🧪 TEST MODE (pas d’appel Replicate)
    if (test_mode) {
      for (let i = 0; i < Math.min(Math.max(parseInt(num_outputs, 10) || 1, 1), 4); i++) {
        const fileId = randomUUID();
        const buf = Buffer.from(B64_JPEG_1x1, "base64");
        const path = `categories/${category}/outputs/${dateSlug}/${fileId}.jpg`;
        const publicUrl = await uploadToSupabasePublic(buf, path);

        await insertMeta({
          created_at: receivedAt,
          prompt,
          category,
          source,
          image_url: publicUrl,
          mode: "gen4-test",
          batch_id,
          input_url: null,
          output_path: path,
          model: "runwayml/gen4-image",
          duration_ms: 1,
        });

        items.push({
          prompt,
          image_url: publicUrl,
          replicate_url: null,
          prediction_id: "test-mode",
          duration_ms: 1,
        });
      }

      return res.status(200).json({
        success: true,
        mode: "gen4-test",
        category,
        batch_id,
        count: items.length,
        duration_ms: Date.now() - started,
        items,
      });
    }

    // 🚀 PROD MODE — Appel à Replicate
    const input = { prompt, aspect_ratio, num_outputs: Math.min(Math.max(parseInt(num_outputs, 10) || 1, 1), 4) };
    console.log("🧪 [gen4] Calling Replicate:", { model: "runwayml/gen4-image", input });

    let pred = await replicate.predictions.create({
      model: req.body.model || "runwayml/gen4-image",
      input,
    });

    // Attente du résultat
    while (["queued", "starting", "processing"].includes(pred.status)) {
      await sleep(1000);
      pred = await replicate.predictions.get(pred.id);
    }

    if (pred.status !== "succeeded") {
      console.error("❌ Gen4 failed:", pred);
      return res.status(502).json({ success: false, error: `replicate_failed_${pred.status}` });
    }

    // Téléchargement + re-upload Supabase
    const outs = Array.isArray(pred.output) ? pred.output : [pred.output];
    for (const u of outs) {
      if (typeof u !== "string") continue;

      const fileId = randomUUID();
      const buf = await fetchAsBuffer(u);
      const path = `categories/${category}/outputs/${dateSlug}/${fileId}.jpg`;
      const publicUrl = await uploadToSupabasePublic(buf, path);

      await insertMeta({
        created_at: receivedAt,
        prompt,
        category,
        source,
        image_url: publicUrl,
        mode: "gen4",
        batch_id,
        input_url: null,
        output_path: path,
        model: "runwayml/gen4-image",
        duration_ms: pred.metrics?.predict_time
          ? Math.round(pred.metrics.predict_time * 1000)
          : null,
      });

      items.push({
        prompt,
        image_url: publicUrl,
        replicate_url: u,
        prediction_id: pred.id,
        duration_ms: pred.metrics?.predict_time
          ? Math.round(pred.metrics.predict_time * 1000)
          : null,
      });
    }

    return res.status(200).json({
      success: true,
      mode: "gen4",
      category,
      batch_id,
      count: items.length,
      duration_ms: Date.now() - started,
      items,
    });
  } catch (e) {
    console.error("❌ /api/generate-gen4-image error:", e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || "internal_error" });
  }
}
