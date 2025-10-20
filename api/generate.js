// api/generate.js
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée (POST attendu)" });
  }

  try {
    const { prompt, num_outputs = 1, aspect_ratio = "1:1", seed = null } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Le prompt est manquant" });
    }

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

    const output = await replicate.run("black-forest-labs/flux-schnell", {
      input: {
        prompt,
        num_outputs,      // 1–4
        aspect_ratio,     // "1:1", "16:9", "2:3", ...
        seed: seed ?? undefined
      },
    });

    const images = Array.isArray(output) ? output : [output];
    const imageUrl = images[0];

    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await supabase.from("images").insert([{ prompt, image_url: imageUrl }]);
    }

    return res.status(200).json({ success: true, imageUrl, images });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erreur lors de la génération." });
  }
}
