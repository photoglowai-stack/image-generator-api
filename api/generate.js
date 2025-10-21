import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: false, // nécessaire pour traiter les fichiers uploadés
  },
};

export default async function handler(req, res) {
  // ✅ Autoriser CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    // ✅ Import dynamique pour parser les fichiers (form-data)
    const formidable = (await import("formidable")).default;
    const form = formidable({ multiples: false });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const prompt = fields.prompt?.[0] || fields.prompt || "";
    const category = fields.category?.[0] || fields.category || "default";
    const seed = fields.seed?.[0] || fields.seed || null;
    const inputImage = files.input_image?.[0]?.filepath || files.input_image?.filepath;

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // ✅ Initialisation Replicate + Supabase
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    // ✅ Appel du modèle Flux-Kontext-Pro
    const model = "black-forest-labs/flux-kontext-pro";
    const input = {
      prompt,
      input_image: inputImage,
      aspect_ratio: "match_input_image",
      output_format: "jpg",
      safety_tolerance: 2,
    };

    const output = await replicate.run(model, { input });
    const imageUrl = Array.isArray(output) ? output[0] : output;

    // ✅ Enregistrer dans Supabase
    const { error } = await supabase
      .from("photos_meta")
      .insert({
        image_url: imageUrl,
        prompt,
        seed,
        category,
        source: "replicate",
      });

    if (error) {
      console.error("❌ Supabase insert error:", error.message);
      return res.status(500).json({ error: "Supabase insert failed" });
    }

    return res.status(200).json({
      message: "✅ Image generated and stored successfully",
      image_url: imageUrl,
      prompt,
      category,
    });
  } catch (e) {
    console.error("❌ Error in /api/generate:", e);
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
