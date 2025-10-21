// /api/generate.js
const Replicate = require("replicate");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      prompt,
      num_outputs = 1,
      aspect_ratio,
      seed, // on ne met plus de valeur par défaut ici
      input_image,
      output_format = "jpg",
      safety_tolerance = 2
    } = body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const isEdit = !!input_image;
    const model = isEdit
      ? "black-forest-labs/flux-kontext-pro"
      : "black-forest-labs/flux-1.1-pro";

    // On construit l’objet d’entrée sans inclure seed si il n’existe pas
    const input = isEdit
      ? {
          prompt,
          input_image,
          aspect_ratio: aspect_ratio || "match_input_image",
          output_format,
          safety_tolerance
        }
      : {
          prompt,
          num_outputs,
          aspect_ratio: aspect_ratio || "1:1",
          ...(seed ? { seed } : {}) // <= ici la magie
        };

    const outputs = await replicate.run(model, { input });

    const urls = await Promise.all(
      (Array.isArray(outputs) ? outputs : [outputs]).map(async (o) => {
        if (o && typeof o.url === "function") return o.url();
        if (typeof o === "string") return o;
        return null;
      })
    );

    return res.status(200).json({ model, urls: urls.filter(Boolean) });
  } catch (e) {
    console.error("Replicate error:", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
};
