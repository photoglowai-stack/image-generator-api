const Replicate = require("replicate");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { prompt, num_outputs = 1, aspect_ratio = "1:1", seed = null } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "Missing prompt" });

    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const model = "black-forest-labs/flux-1.1-pro";

    const output = await replicate.run(model, { input: { prompt, num_outputs, aspect_ratio, seed } });
    res.status(200).json({ output });
  } catch (e) {
    console.error("Replicate error:", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
};
