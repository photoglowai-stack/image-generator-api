// /api/generate-from-scratch.js
const Replicate = require("replicate");
const { createClient } = require("@supabase/supabase-js");

const ALLOWED_AR = new Set([
  "1:1","16:9","9:16","4:3","3:4","3:2","2:3","4:5","5:4","21:9","9:21","2:1","1:2"
]);
const toNumberOrNull = (v) => (typeof v === "number" ? v : (typeof v === "string" && v.trim() && !Number.isNaN(+v) ? +v : null));

module.exports = async (req, res) => {
  // CORS + healthcheck
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, endpoint: "text2img" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const norm = (x) => (typeof x === "string" ? x.trim() : x);

    const prompt       = norm(body.prompt);
    let   aspect_ratio = norm(body.aspect_ratio) || "1:1";          // pour text2img
    const category     = norm(body.category) || "default";
    const source       = norm(body.source) || "replicate-text2img";
    const num_outputs  = toNumberOrNull(body.num_outputs) || 1;
    const seed         = toNumberOrNull(body.seed);

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'prompt' (string)" });
    }
    if (!ALLOWED_AR.has(aspect_ratio)) aspect_ratio = "1:1";        // sanitize

    // Choix du modèle text2img (configurable)
    const model = process.env.TEXT2IMG_MODEL || "black-forest-labs/flux-1.1-pro";
    const input = {
      prompt,
      aspect_ratio,
      num_outputs,
      ...(seed != null ? { seed } : {}),
      output_format: "jpg",
      safety_tolerance: 2,
    };

    console.log("🧪 [t2i] Calling Replicate:", { model, input });
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const outputs = await replicate.run(model, { input });
    const arr = Array.isArray(outputs) ? outputs : [outputs];
    const replicateUrl = arr[0];
    if (!replicateUrl) return res.status(500).json({ error: "No output from Replicate" });

    // Download -> upload to Supabase
    const r = await fetch(replicateUrl);
    if (!r.ok) throw new Error("Download failed: " + r.status);
    const buffer = Buffer.from(await r.arrayBuffer());

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const filename = `outputs/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const { error: upErr } = await supabase.storage.from("photos").upload(filename, buffer, {
      contentType: "image/jpeg",
      upsert: true,
    });
    if (upErr) {
      console.error("❌ Supabase upload error:", upErr);
      return res.status(500).json({ error: "Supabase upload failed" });
    }

    const { data: pub } = supabase.storage.from("photos").getPublicUrl(filename);
    const supaUrl = pub?.publicUrl;

    // Meta
    const { error: insErr } = await supabase.from("photos_meta").insert({
      image_url: supaUrl,
      prompt,
      seed: seed ?? null,
      category,
      source,
    });
    if (insErr) console.warn("⚠️ Supabase insert warning:", insErr);

    return res.status(200).json({
      success: true,
      mode: "text2img",
      model,
      image_url: supaUrl,        // ← URL durable à utiliser
      replicate_url: replicateUrl
    });
  } catch (e) {
    console.error("❌ /api/generate-from-scratch error:", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
};
