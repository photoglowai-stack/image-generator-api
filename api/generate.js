// /api/generate.js
const Replicate = require("replicate");
const { createClient } = require("@supabase/supabase-js");

// Petit util pour forcer un nombre propre
const toNumberOrNull = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const normStr = (v) => (typeof v === "string" ? v.trim() : v);

    const prompt       = normStr(body.prompt);
    const aspect_ratio = normStr(body.aspect_ratio) || "1:1";
    const category     = normStr(body.category) || "default";
    const source       = normStr(body.source) || "replicate";
    const num_outputs  = Number(body.num_outputs || 1);
    const seedRaw      = body.seed ?? null;
    const seed         = toNumberOrNull(seedRaw); // ← corrige le "seed_type: object" vu dans tes logs

    const input_image =
      normStr(body.input_image) ||
      normStr(body.inputImage) ||
      normStr(body.image_url)  ||
      normStr(body.imageUrl)   ||
      null;

    console.log("🧾 /api/generate received:", {
      typeof_body: typeof body,
      prompt,
      input_image,
      aspect_ratio,
      category,
      num_outputs,
      seed_type: typeof seedRaw
    });

    if (!prompt || typeof prompt !== "string" || !prompt.length) {
      return res.status(400).json({ error: "Missing or invalid 'prompt' (string required)" });
    }

    const isEdit = typeof input_image === "string" && /^https?:\/\//.test(input_image);
    if (("input_image" in body || "inputImage" in body || "image_url" in body || "imageUrl" in body) && !isEdit) {
      return res.status(400).json({
        error: "Invalid 'input_image'. Must be a public HTTP(S) URL (string). Received: " + String(input_image)
      });
    }

    const model = isEdit
      ? "black-forest-labs/flux-kontext-pro" // img2img
      : "black-forest-labs/flux-1.1-pro";    // text2img

    const input = isEdit
      ? {
          prompt,
          input_image,
          aspect_ratio: aspect_ratio || "match_input_image",
          output_format: "jpg",
          safety_tolerance: 2,
        }
      : {
          prompt,
          num_outputs,
          aspect_ratio,
          ...(seed !== null ? { seed } : {}),
        };

    console.log("🧪 Calling Replicate:", { model, input });

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const outputs = await replicate.run(model, { input });
    const outUrls = Array.isArray(outputs) ? outputs : [outputs];
    const replicateUrl = outUrls[0];

    // 🔽 Télécharge l'image générée (Node 18+ : fetch natif)
    const r = await fetch(replicateUrl);
    if (!r.ok) throw new Error("Failed to download replicate image: " + r.status);
    const arrayBuf = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // 🗄️ Upload dans Supabase (bucket 'photos')
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const filename = `outputs/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const { data: up, error: upErr } = await supabase.storage
      .from("photos")
      .upload(filename, buffer, { contentType: "image/jpeg", upsert: true });

    if (upErr) {
      console.error("❌ Supabase upload error:", upErr);
      return res.status(500).json({ error: "Supabase upload failed" });
    }

    const { data: pub } = supabase.storage.from("photos").getPublicUrl(filename);
    const supabaseUrl = pub?.publicUrl;

    // 📝 Enregistre meta (URL finale = Supabase)
    const { error: insertError } = await supabase.from("photos_meta").insert({
      image_url: supabaseUrl,
      prompt,
      seed: seed ?? null,
      category,
      source
    });
    if (insertError) console.error("⚠️ Supabase insert error:", insertError);

    // 🔁 Réponse front : on renvoie l’URL Supabase pour affichage direct
    return res.status(200).json({
      success: true,
      model,
      image_url: supabaseUrl,      // ← à utiliser dans Figma
      replicate_url: replicateUrl, // ← utile en debug si besoin
    });
  } catch (e) {
    console.error("❌ Handler error:", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
};
