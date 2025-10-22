// /api/generate.js → wrapper rétro-compatible vers /api/generate-batch
const batch = require("./generate-batch");

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, endpoint: "img2img/text2img (redirects to generate-batch)" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const norm = (v) => (typeof v === "string" ? v.trim() : v);

    const prompt       = norm(body.prompt);
    const category     = norm(body.category) || "ai-headshots";
    const source       = norm(body.source) || "figma";
    const input_image  = norm(body.input_image) || norm(body.inputImage) || norm(body.image_url) || norm(body.imageUrl) || null;
    const aspect_ratio = norm(body.aspect_ratio) || (input_image ? "match_input_image" : "1:1");
    const model        = norm(body.model); // optionnel

    // Rétro-compat: num_outputs → on duplique le prompt (cap à 4)
    const num_outputs = Math.max(1, Math.min(Number(body.num_outputs || 1), 4));
    const prompts = Array.from({ length: num_outputs }, () => prompt).filter(Boolean);

    if (!prompt) return res.status(400).json({ error: "Missing 'prompt' (string)" });
    if ((body.input_image || body.inputImage || body.image_url || body.imageUrl) && !(typeof input_image === "string" && /^https?:\/\//.test(input_image))) {
      return res.status(400).json({ error: "Invalid 'input_image' (must be a public http(s) URL string)" });
    }

    // Construire la charge utile attendue par /api/generate-batch
    const newBody = {
      category,
      prompts,
      aspect_ratio,
      source: input_image ? "figma-img2img" : "figma-text2img",
      ...(input_image ? { input_image } : {}),
      ...(model ? { model } : {}),
    };

    // Délégation au handler batch (même process)
    req.method = "POST";
    req.body = newBody;
    return batch(req, res);
  } catch (e) {
    console.error("❌ /api/generate redirect error:", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
};
