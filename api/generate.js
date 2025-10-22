// /api/generate-from-scratch.js
// Transition: compat historique → délègue à /api/generate (text2img)
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    // On force le mode text2img (ancien endpoint faisait du text2img)
    const payload = {
      prompt: body.prompt,
      category: body.category || "ai-headshots",
      aspect_ratio: body.aspect_ratio || "1:1",
      num_outputs: Math.min(Math.max(parseInt(body.num_outputs || 1, 10), 1), 4),
      negative_prompt: body.negative_prompt,
      seed: body.seed,
      source: body.source || "compat-generate-from-scratch",
      test_mode: body.test_mode === true
    };

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const url   = `${proto}://${host}/api/generate`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("❌ /api/generate-from-scratch proxy error:", e?.message || e);
    return res.status(500).json({ error: "internal_error_proxy" });
  }
}
