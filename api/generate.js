// /api/generate.js
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const form = formidable();
    const [fields, files] = await form.parse(req);
    const prompt = fields.prompt?.[0];
    const category = fields.category?.[0] || "default";
    const aspect_ratio = fields.aspect_ratio?.[0] || "1:1";

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );

    let input_image_url = null;
    if (files.input_image?.[0]) {
      const file = files.input_image[0];
      const fileBuffer = fs.readFileSync(file.filepath);
      const { data, error } = await supabase.storage
        .from("photos")
        .upload(`uploads/${Date.now()}-${file.originalFilename}`, fileBuffer, {
          contentType: file.mimetype,
        });
      if (error) throw new Error("Supabase upload failed");
      input_image_url = `${process.env.SUPABASE_URL}/storage/v1/object/public/photos/${data.path}`;
    }

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const input = {
      prompt,
      input_image: input_image_url,
      aspect_ratio,
      output_format: "jpg",
      safety_tolerance: 2,
    };

    const output = await replicate.run("black-forest-labs/flux-kontext-pro", { input });

    const image_url = Array.isArray(output) ? output[0] : output;

    await supabase.from("photos_meta").insert({
      image_url,
      prompt,
      category,
      source: "replicate",
    });

    return res.status(200).json({ success: true, replicate_output: image_url });
  } catch (e) {
    console.error("Error:", e);
    return res.status(500).json({ error: e.message });
  }
}
