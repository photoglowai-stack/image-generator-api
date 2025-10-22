import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 👉 Choisis ici le bucket de SORTIE (tu as "generated_images" dans Supabase)
const OUTPUT_BUCKET = "generated_images"; // <— change depuis "photos"

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, endpoint: "gen4-image" });
    }

    const t0 = Date.now();
    const {
      prompt,
      reference_images = [],         // 0..3 URLs publiques
      aspect_ratio = "16:9",
      resolution = "1080p",          // "720p" | "1080p"
      seed,
      category = "gen4-image",
      source = "photoglow-gen4",
      user_id                         // optionnel: pour décrémenter les crédits
    } = req.body ?? {};

    if (!prompt || typeof prompt !== "string") {
      return res.status(422).json({ error: "prompt (string) requis" });
    }
    if (!Array.isArray(reference_images)) {
      return res.status(422).json({ error: "reference_images doit être un tableau de strings (URLs)" });
    }
    if (reference_images.length > 3) {
      return res.status(422).json({ error: "reference_images: maximum 3" });
    }
    if (!["720p","1080p"].includes(resolution)) {
      return res.status(422).json({ error: "resolution doit être '720p' ou '1080p'" });
    }

    console.log("🧾 /api/generate-gen4-image received:", {
      prompt,
      refs: reference_images.length,
      aspect_ratio,
      resolution,
      seed,
      user_id
    });

    const input = {
      prompt,
      reference_images,
      aspect_ratio,
      resolution,
      ...(seed != null ? { seed: Number(seed) } : {})
    };

    console.log("🧪 Calling Replicate:", { model: "runwayml/gen4-image", input });

    const output = await replicate.run("runwayml/gen4-image", { input });
    const replicateUrl = typeof output === "string" ? output : Array.isArray(output) ? output[0] : null;
    if (!replicateUrl) {
      return res.status(500).json({ error: "Aucune URL image retournée par Replicate" });
    }

    // Download output → upload Supabase
    const resp = await fetch(replicateUrl);
    if (!resp.ok) return res.status(502).json({ error: `Download failed: ${resp.status}` });
    const buf = Buffer.from(await resp.arrayBuffer());

    const today = new Date().toISOString().slice(0,10);
    const fileName = `outputs/${today}/${randomUUID()}.jpg`;

    // ✅ UPLOAD dans le bucket de sortie choisi
    const { error: upErr } = await supabase.storage
      .from(OUTPUT_BUCKET)
      .upload(fileName, buf, { contentType: "image/jpeg", cacheControl: "31536000" });
    if (upErr) {
      console.error("Supabase upload error:", upErr);
      return res.status(500).json({ error: "Supabase upload failed" });
    }

    // ✅ URL publique depuis le même bucket
    const { data: pub } = supabase.storage.from(OUTPUT_BUCKET).getPublicUrl(fileName);
    const image_url = pub?.publicUrl;

    const duration_ms = Date.now() - t0;

    // meta
    try {
      await supabase.from("photos_meta").insert({
        image_url, prompt, category, source, mode: "text2img-gen4", duration_ms
      });
      console.log("Insert photos_meta OK");
    } catch (e) {
      console.warn("Insert photos_meta WARN:", e?.message || e);
    }

    // décrément crédits (optionnel)
    if (user_id) {
      // await supabase.rpc("decrement_credits", { uid: user_id });
    }

    return res.status(200).json({
      success: true,
      mode: "text2img-gen4",
      model: "runwayml/gen4-image",
      image_url,
      replicate_url: replicateUrl,
      duration_ms
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unhandled error", detail: e?.message || String(e) });
  }
}
