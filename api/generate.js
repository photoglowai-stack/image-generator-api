import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false, // nécessaire pour traiter le FormData (fichiers)
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
    const aspect_ratio = fields.aspect_ratio?.[0] || fields.aspect_ratio || "1:1";

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // ✅ Initialisation Replicate + Supabase
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    // ✅ Upload de l'image dans Supabase Storage
    const file = files.input_image?.[0];
    if (!file) {
      return res.status(400).json({ error: "Missing input_image file" });
    }

    const fileData = await fs.promises.readFile(file.filepath);
    const fileName = `uploads/${Date.now()}_${file.originalFilename}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("photos")
      .upload(fileName, fileData, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error("❌ Supabase upload error:", uploadError.message);
      return res.status(500).json({ error: "Supabase upload failed" });
    }

    // ✅ Récupération de l’URL publique
    const { data: publicUrlData } = supabase.storage
      .from("photos")
      .getPublicUrl(fileName);

    const inputImageUrl = publicUrlData.publicUrl;

    // ✅ Envoi à Replicate (Flux-Kontext-Pro)
    const model = "black-forest-labs/flux-kontext-pro";
    const input = {
      prompt,
      input_image: inputImageUrl,
      aspect_ratio: aspect_ratio || "match_input_image",
      output_format: "jpg",
      safety_tolerance: 2,
    };

    console.log("🧠 Sending to Replicate:", input);
    const output = await replicate.run(model, { input });
    const imageUrl = Array.isArray(output) ? output[0] : output;

    console.log("✅ Generated image:", imageUrl);

    // ✅ Enregistrement dans Supabase
    const { error: insertError } = await supabase
      .from("photos_meta")
      .insert({
        image_url: imageUrl,
        prompt,
        category,
        source: "replicate",
      });

    if (insertError) {
      console.error("❌ Supabase insert error:", insertError.message);
      return res.status(500).json({ error: "Supabase insert failed" });
    }

    // ✅ Réponse finale
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
