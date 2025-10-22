const Replicate = require("replicate");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const AR_IMG2IMG = new Set(["match_input_image","1:1","16:9","9:16","4:3","3:4","3:2","2:3","4:5","5:4","21:9","9:21","2:1","1:2"]);
const AR_T2I    = new Set(["1:1","16:9","9:16","4:3","3:4","3:2","2:3","4:5","5:4","21:9","9:21","2:1","1:2"]);

const slugify = s => (String(s || "default").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") || "default");
const today   = () => new Date().toISOString().slice(0,10);
const uuid    = () => crypto.randomUUID();

async function downloadBuffer(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error("Download failed: " + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function uploadOutputToGenerated(supabase, categorySlug, buffer){
  const path = `categories/${categorySlug}/outputs/${today()}/${uuid()}.jpg`;
  const { error } = await supabase.storage.from("generated_images").upload(path, buffer, {
    contentType: "image/jpeg",
    upsert: true,
    cacheControl: "31536000",
  });
  if (error) throw error;
  const { data: pub } = supabase.storage.from("generated_images").getPublicUrl(path);
  return { outputPath: path, outputUrl: pub.publicUrl };
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, endpoint: "generate-batch" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const t0 = Date.now();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const norm = x => (typeof x === "string" ? x.trim() : x);

    const categorySlug = slugify(norm(body.category) || "default");
    const input_image  = norm(body.input_image) || null;

    const prompts = Array.isArray(body.prompts)
      ? body.prompts.map(norm).filter(Boolean)
      : [norm(body.prompt)].filter(Boolean);
    if (!prompts.length) return res.status(400).json({ error: "Provide 'prompt' or 'prompts'[]" });

    const isImg2Img = !!input_image;
    const model = isImg2Img
      ? (body.model || "black-forest-labs/flux-kontext-pro")
      : (body.model || process.env.TEXT2IMG_MODEL || "black-forest-labs/flux-1.1-pro");

    let aspect_ratio = norm(body.aspect_ratio);
    if (isImg2Img && !AR_IMG2IMG.has(aspect_ratio)) aspect_ratio = "match_input_image";
    if (!isImg2Img && !AR_T2I.has(aspect_ratio)) aspect_ratio = "1:1";

    const source = norm(body.source) || (isImg2Img ? "figma-img2img" : "figma-text2img");

    const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

    const batch_id = uuid();
    const items = [];
    const mode = isImg2Img ? "img2img" : "text2img";

    for (const prompt of prompts) {
      const input = isImg2Img
        ? { prompt, input_image, aspect_ratio, output_format: "jpg", safety_tolerance: 2 }
        : { prompt, aspect_ratio, output_format: "jpg", safety_tolerance: 2 };

      console.log("🧪 [batch] Calling Replicate:", { model, input });
      const outputs = await replicate.run(model, { input });
      const arr = Array.isArray(outputs) ? outputs : [outputs];

      for (const replicateUrl of arr) {
        const buf = await downloadBuffer(replicateUrl);
        const { outputPath, outputUrl } = await uploadOutputToGenerated(supabase, categorySlug, buf);

        const { error: insErr } = await supabase.from("photos_meta").insert({
          image_url: outputUrl,
          prompt,
          category: categorySlug,
          category_slug: categorySlug,
          source,
          mode,
          batch_id,
          input_url: input_image || null,
          input_path: null,
          output_path: outputPath,
          created_at: new Date().toISOString(),
        });
        if (insErr) console.warn("⚠️ Supabase insert warning:", insErr);

        items.push({ prompt, image_url: outputUrl, replicate_url: replicateUrl });
      }
    }

    const duration_ms = Date.now() - t0;
    return res.status(200).json({ success: true, mode, category: categorySlug, batch_id, count: items.length, duration_ms, items });
  } catch (e) {
    console.error("❌ /api/generate-batch error:", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
};
