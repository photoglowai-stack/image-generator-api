// /api/generate.js
// Wrapper simple : normalise la payload et forward en POST vers /api/generate-batch
// (corrige l'erreur "batch is not a function")

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    console.log("🧾 /api/generate received:", body);

    // Normalisation légère
    const payload = {
      // on passe au batch tel quel
      ...body,
      source: body.source || "wrapper-generate"
    };

    // Si img2img → on force un AR safe côté wrapper aussi (le batch le refera de toute façon)
    if (payload.input_image && payload.aspect_ratio !== "match_input_image") {
      payload.aspect_ratio = "match_input_image";
    }

    // Construit l’URL interne de l’API batch (compatible Vercel preview/prod)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const url   = `${proto}://${host}/api/generate-batch`;

    // Proxy POST
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));
    // On propage le status HTTP du batch
    return res.status(r.status).json(data);
  } catch (err) {
    console.error("❌ /api/generate error:", err?.message || err);
    return res.status(500).json({ error: "internal_error_generate_wrapper" });
  }
}
