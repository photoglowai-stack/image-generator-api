// /api/generate.js
const Replicate = require("replicate");
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  // Autoriser CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    // 🧠 Récupération du corps de la requête
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const {
      prompt,
      num_outputs = 1,
      aspect_ratio = "1:1",
      seed,
      input_image,
      category = "default",
      source = "replicate",
    } = body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // 🔐 Initialisation des clients
    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN,
    });

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    // 🎨 Choix du modèle selon si une image est fournie ou non
    const isEdit = !!input_image;
    const model = isEdit
      ? "black-forest-labs/flux-kontext-pro" // image -> image
      : "black-forest-labs/flux-1.1-pro"; // texte -> image

    // 🧩 Construction des inputs
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
          aspect_ratio: aspect_ratio || "1:1",
          ...(seed ? { seed } : {}), // ✅ ajoute seed uniquement s’il existe
        };

    // 🚀 Exécution du modèle sur Replicate
    const outputs = await replicate.run(model, { input });
    const urls = Array.isArray(outputs) ? outputs : [outputs];

    // 🗄️ Insertion automatique dans Supabase
    const { error } = await supabase.from("photos_meta").insert({
      image_url: urls[0],
      prompt,
      seed: seed || null,
      category,
      source,
    });

    if (error) console.error("⚠️ Supabase insert error:", error.message);

    // ✅ Retourner les résultats au front
    return res.status(200).json({ model, urls });
  } catch (e) {
    console.error("❌ Replicate error:", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
};
