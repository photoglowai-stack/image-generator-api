// /api/generate-gen4-image.js
// Monofichier "endurci": CORS + logs + rate-limit + test_mode + prod Replicate + Supabase re-host

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

// ---------- Config & clients ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || "*"; // mets ton front quand tu veux durcir

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

// ---------- Utilitaires ----------
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", FRONT_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
}

const hits = new Map(); // rate-limit en mémoire (OK pour dev/gratuit)
function rateLimit(req, res, { windowMs = 60_000, max = 60 } = {}) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "ip";
  const key = `${ip}:${req.url || ""}`;
  const now = Date.now();
  const v = hits.get(key) || { n: 0, t: now };
  if (now - v.t > windowMs) { v.n = 0; v.t = now; }
  v.n++; hits.set(key, v);
  if (v.n > max) {
    res.status(429).json({ success: false, error: "rate_limit_exceeded" });
    return false;
  }
  return true;
}

function log(res, level, data) {
  const rid = res.getHeader("x-request-id");
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, request_id: rid, route: "/api/generate-gen4-image", ...data }));
}

function todayISODate() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download_failed_${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadToSupabasePublic(buffer, path) {
  const { error } = await supabase.storage.from("generated_images").upload(path, buffer, {
    contentType: "image/jpeg", cacheControl: "31536000", upsert: false
  });
  if (error) throw error;
  const { data } = supabase.storage.from("generated_images").getPublicUrl(path);
  return data.publicUrl;
}

async function insertMeta(row) {
  const { error } = await supabase.from("photos_meta").insert(row);
  if (error) console.warn("⚠️ insert photos_meta failed:", error.message);
}

// 1x1 JPEG pour test_mode (fake)
const B64_JPEG_1x1 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEA8QDw8PDw8PDw8PDw8PDw8PDw8PFREWFhURGyggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGi0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAABAgME/8QAFxABAQEBAAAAAAAAAAAAAAAAAQIDAP/aAAwDAQACEQMRAD8A4kYAAAAA//Z";

// ---------- Handler ----------
export default async function handler(req, res) {
  setCORS(res);
  res.setHeader("x-request-id", randomUUID());

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!rateLimit(req, res)) return; // 429 envoyé

  const started = Date.now();
  log(res, "info", { msg: "🧾 request", method: req.method });

  try {
    const {
      prompt,
      aspect_ratio = "16:9",
      num_outputs = 1,
      source = "api-gen4",
      test_mode = false,
      category = "ai-headshots",
      model = "runwayml/gen4-image"
    } = req.body || {};

    if (!prompt && !test_mode)
      return res.status(400).json({ success: false, error: "Missing prompt" });

    // Garde-fou: token Replicate requis en prod
    if (!test_mode && (!REPLICATE_API_TOKEN || REPLICATE_API_TOKEN === "")) {
      return res.status(500).json({ success: false, error: "replicate_token_missing" });
    }

    const dateSlug = todayISODate();
    const batch_id = randomUUID();
    const receivedAt = new Date().toISOString();
    const n = Math.min(Math.max(parseInt(num_outputs, 10) || 1, 1), 4);
    const items = [];

    // ---------- TEST MODE ----------
    if (test_mode) {
      for (let i = 0; i < n; i++) {
        const fileId = randomUUID();
        const buf = Buffer.from(B64_JPEG_1x1, "base64");
        const path = `categories/${category}/outputs/${dateSlug}/${fileId}.jpg`;
        const publicUrl = await uploadToSupabasePublic(buf, path);

        await insertMeta({
          created_at: receivedAt,
          prompt, category, source,
          image_url: publicUrl, mode: "gen4-test",
          batch_id, input_url: null, output_path: path,
          model, duration_ms: 1
          // user_id: null // à renseigner quand tu brancheras l’auth site
        });

        items.push({ prompt, image_url: publicUrl, replicate_url: null, prediction_id: "test-mode", duration_ms: 1 });
      }

      log(res, "info", { msg: "✅ done", mode: "gen4-test", count: items.length, duration_ms: Date.now() - started });
      return res.status(200).json({ success: true, mode: "gen4-test", category, batch_id, count: items.length, duration_ms: Date.now() - started, items });
    }

    // ---------- PROD MODE (Replicate) ----------
    log(res, "info", { msg: "🧪 provider.call", provider: "replicate", model, n, aspect_ratio });

    let pred = await replicate.predictions.create({ model, input: { prompt, aspect_ratio, num_outputs: n } });
    while (["queued", "starting", "processing"].includes(pred.status)) {
      await new Promise(r => setTimeout(r, 1000));
      pred = await replicate.predictions.get(pred.id);
    }
    if (pred.status !== "succeeded") {
      log(res, "error", { msg: "❌ provider.failed", status: pred.status });
      return res.status(502).json({ success: false, error: `replicate_failed_${pred.status}` });
    }

    const outs = Array.isArray(pred.output) ? pred.output : [pred.output];
    for (const u of outs) {
      if (typeof u !== "string") continue;
      const fileId = randomUUID();
      const buf = await fetchAsBuffer(u);
      // (Optionnel) compression avec sharp — non incluse ici pour rester monofichier
      const path = `categories/${category}/outputs/${dateSlug}/${fileId}.jpg`;
      const publicUrl = await uploadToSupabasePublic(buf, path);

      await insertMeta({
        created_at: receivedAt,
        prompt, category, source,
        image_url: publicUrl, mode: "gen4",
        batch_id, input_url: null, output_path: path,
        model,
        duration_ms: pred.metrics?.predict_time ? Math.round(pred.metrics.predict_time * 1000) : null
        // user_id: null // à renseigner côté site auth
      });

      items.push({
        prompt, image_url: publicUrl, replicate_url: u, prediction_id: pred.id,
        duration_ms: pred.metrics?.predict_time ? Math.round(pred.metrics.predict_time * 1000) : null
      });
    }

    log(res, "info", { msg: "✅ done", mode: "gen4", count: items.length, duration_ms: Date.now() - started });
    return res.status(200).json({ success: true, mode: "gen4", category, batch_id, count: items.length, duration_ms: Date.now() - started, items });
  } catch (e) {
    log(res, "error", { msg: "❌ unhandled", error: e?.message || String(e) });
    return res.status(500).json({ success: false, error: e?.message || "internal_error" });
  }
}
