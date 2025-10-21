// /api/generate.js
const Replicate = require("replicate");
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    // 1) Parse JSON (Vercel donne déjà un objet si Content-Type: application/json)
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    // 2) Normalise les clés pour éviter les erreurs de casse/nommage
    const normalize = (v) => (typeof v === "string" ? v.trim() : v);
    const input_image =
      normalize(rawBody.input_image) ||
      normalize(rawBody.inputImage) ||
      normalize(rawBody.image_url) ||
      normalize(rawBody.imageUrl) ||
      null;

    const prompt = normalize(rawBody.prompt);
    const aspect_ratio = normalize(rawBody.aspect_ratio) || "1:1";
    const category = normalize(rawBody.category) || "default";
    const source = normalize(rawBody.source) || "replicate";
    const num_outputs = Number(rawBody.num_outputs || 1);
    const seed = rawBody.seed ?? null;

    // 3) Logs utiles (ce que TON API reçoit réellement)
    console.log("🧾 /api/generate received:", {
      typeof_body: typeof rawBody,
      prompt,
      input_image,
      aspect_ratio,
      category,
      num_outputs,
      seed_type: typeof seed,
    });

    // 4) Validations simples et pédagogiques
    if (!prompt || typeof prompt !== "string" || !prompt.length) {
      return res.status(400).json({ error: "Missing or invalid 'prompt' (string required)" });
    }

    // Est-ce qu’on est en mode img2img (edit) ?
    const isEdit = typeof input_image === "string" && input_image.startsWith("http");
    // Si tu voulais forcer l’edit, on bloque proprement
    if (rawBody.input_image !== undefined && !isEdit) {
      return res.status(400).json({
        error:
          "Invalid 'input_image'. Must be a public HTTP(S) URL (string). Received: " + String(input_image),
      });
    }

    // 5) Choix du modèle
    const model = isEdit
      ? "black-forest-labs/flux-kontext-pro" // img2img
      : "black-forest-labs/flux-1.1-pro";     // text2img

    // 6) Construction des inputs Replicate
    const input = isEdit
      ? {
          prompt,
          input_image,                    // ⚠️ exige une STRING non vide
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

    // 7) Log exactement ce qu’on ENVOIE à Replicate (clé du debug)
    console.log("🧪 Calling Replicate:", { model, input });

    // 8) Appel Replicate
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const outputs = await replicate.run(model, { input });

    // 9) Normalise la sortie en tableau d’URLs
    const urls = Array.isArray(outputs) ? outputs : [outputs];
    const firstUrl = urls[0];

    // 10) Sauvegarde Supabase (meta)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { error: insertError } = await supabase.from("photos_meta").insert({
      image_url: firstUrl,
      prompt,
      seed: seed ?? null,
      category,
      source,
    });
    if (insertError) console.error("⚠️ Supabase insert error:", insertError);

    // 11) Réponse front
    return res.status(200).json({ success: true, model, urls });
  } catch (e) {
    console.error("❌ Handler error:", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
};
