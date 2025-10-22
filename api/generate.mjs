// /api/generate.mjs
// IMG2IMG (Flux Kontext Pro) — sécurisé (Bearer token), CORS, débit crédits, re-upload Supabase, insertion meta.
// Invariants : re-héberger la sortie dans Supabase outputs/YYYY-MM-DD/<uuid>.jpg puis INSERT photos_meta.
// Logs attendus : 🧾 received → 🧪 Calling Replicate → 📦 stored.

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

function setCORS(res) {
  // ⚠️ Durcis avec FRONT_ORIGIN si besoin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

const BUCKET_IMAGES = process.env.BUCKET_IMAGES || "photos";
const TABLE_META = process.env.TABLE_META || "photos_meta";
const IMG2IMG_MODEL = process.env.MODEL_IMG2IMG || "black-forest-labs/flux-kontext-pro";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

const VALID_AR = new Set(["1:1","16:9","9:16","4:3","3:4","3:2","2:3","4:5","5:4","21:9","9:21","2:1","1:2","match_input_image"]);

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET")     return res.status(200).json({ ok: true, endpoint: "img2img" });
  if (req.method !== "POST")    return res.status(405).json({ success: false, error: "method_not_allowed" });

  try {
    // --- Auth (Bearer Supabase) ---
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData?.user) return res.status(401).json({ success: false, error: "invalid_token" });
    const user_id = userData.user.id;

    // --- Payload ---
    const {
      input_image,          // URL publique Supabase (uploads/...)
      prompt,
      category = "ai-headshots",
      aspect_ratio = "match_input_image",
      source = "figma-img2img",
      negative_prompt,
      seed,
      num_outputs = 1
    } = req.body || {};

    if (!input_image || typeof input_image !== "string" || !/^https?:\/\//.test(input_image)) {
      return res.status(400).json({ success: false, error: "invalid_input_image" });
    }
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ success: false, error: "invalid_prompt" });
    }
    if (!VALID_AR.has(aspect_ratio)) {
      return res.status(400).json({ success: false, error: "invalid_aspect_ratio" });
    }

    const started = Date.now();
    console.log("🧾 /api/generate received:", {
      prompt: String(prompt).slice(0, 120),
      input_image: input_image.slice(0, 80),
      aspect_ratio, source, num_outputs
    });

    // --- Débit crédits (atomique via RPC) ---
    const PRICE = 1;
    const debit = await supabase.rpc("debit_credits", { p_user_id: user_id, p_amount: PRICE });
    if (debit.error) {
      if (String(debit.error.message).includes("insufficient_credits")) {
        return res.status(402).json({ success: false, error: "insufficient_credits" });
      }
      return res.status(500).json({ success: false, error: debit.error.message });
    }

    // --- Appel Replicate (IMG2IMG) ---
    // Modèle : Flux Kontext Pro. Entrées usuelles: image + prompt (+ aspect_ratio si souhaité).
    const input = {
      image: input_image,
      prompt,
      output_format: "jpg",
      ...(aspect_ratio !== "match_input_image" ? { aspect_ratio } : {}),
      ...(negative_prompt ? { negative_prompt } : {}),
      ...(Number.isInteger(seed) ? { seed } : {}),
      ...(Number.isInteger(num_outputs) ? { num_outputs } : {})
    };

    console.log("🧪 Calling Replicate:", {
      model: IMG2IMG_MODEL,
      input: { ...input, prompt: String(input.prompt).slice(0, 60) + "..." }
    });

    const out = await replicate.run(`${IMG2IMG_MODEL}:latest`, { input });
    const urls = Array.isArray(out) ? out : (out?.output || out?.urls || []);
    if (!urls?.length) return res.status(502).json({ success: false, error: "provider_no_output" });

    // --- Re-upload → Supabase (outputs/YYYY-MM-DD/uuid.jpg) ---
    const today = new Date().toISOString().slice(0, 10);
    const uploaded = [];
    for (const u of urls) {
      const r = await fetch(u);
      const buf = Buffer.from(await r.arrayBuffer());
      const path = `outputs/${today}/${crypto.randomUUID()}.jpg`;

      const { error: upErr } = await supabase.storage
        .from(BUCKET_IMAGES)
        .upload(path, buf, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
      if (upErr) return res.status(500).json({ success: false, error: `upload_failed:${upErr.message}` });

      const { data: pub } = await supabase.storage.from(BUCKET_IMAGES).getPublicUrl(path);
      uploaded.push(pub.publicUrl);
    }

    // --- INSERT metadata ---
    const duration_ms = Date.now() - started;
    const { error: insErr } = await supabase
      .from(TABLE_META)
      .insert({
        image_url: uploaded[0],
        prompt,
        category,
        source,
        mode: "img2img",
        duration_ms,
        user_id
      });
    if (insErr) console.warn("⚠️ insert_meta_failed:", insErr.message);

    console.log("📦 stored:", { image_url: uploaded[0], duration_ms });

    return res.status(200).json({
      success: true,
      mode: "img2img",
      model: IMG2IMG_MODEL,
      image_url: uploaded[0],
      replicate_url: urls[0],
      duration_ms
    });
  } catch (e) {
    console.error("❌ /api/generate error:", e);
    return res.status(500).json({ success: false, error: "internal_error" });
  }
}
