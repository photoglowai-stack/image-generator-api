// /api/v1-jobs.mjs
// Unique endpoint v1 : reçoit le payload standard, délègue à /api/generate-gen4-image.mjs,
// gère CORS (Origin: null pour Figma) et renvoie un JSON stable {ok, job_id, status, image_url, meta}

function setCORS(req, res) {
  const origin = req.headers.origin || "";
  const allowNull = process.env.ALLOW_NULL_ORIGIN === "true";
  const front = process.env.FRONT_ORIGIN || "*";
  const allowOrigin = (allowNull && origin === "null") ? "null" : front;
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(req, res) {
  setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    const b = req.body || {};
    // Validation minimale (le front Figma valide déjà le reste)
    if (!b?.mode || !["text2img","img2img"].includes(b.mode)) {
      return res.status(422).json({ ok:false, error:"invalid_mode" });
    }
    if (!b?.model || !["flux","gen4"].includes(b.model)) {
      return res.status(422).json({ ok:false, error:"invalid_model" });
    }
    if (!b?.prompt_final || typeof b.prompt_final !== "string" || b.prompt_final.length < 5) {
      return res.status(422).json({ ok:false, error:"invalid_prompt_final" });
    }
    if (b.mode === "img2img" && !b?.image_url) {
      return res.status(422).json({ ok:false, error:"image_url_required_for_img2img" });
    }

    // --------- Délégation à ta fonction unifiée existante ----------
    // On appelle /api/generate-gen4-image.mjs (elle sait gérer flux OU gen4).
    // On re-map juste les clés demandées.
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const url = `${proto}://${host}/api/generate-gen4-image`;

    const providerPayload = {
      mode: b.mode,                  // "text2img" | "img2img"
      model: b.model,                // "flux" | "gen4"  (le fichier interne mappe vers Replicate)
      prompt: b.prompt_final,        // <- remap
      image_url: b.image_url || "",
      aspect_ratio: b.aspect_ratio || "1:1",
      prompt_strength: b.prompt_strength ?? (b.mode === "img2img" ? 0.65 : undefined),
      guidance: b.guidance,
      seed: b.seed,
      // On transmet quand même; le provider interne l'ignorera si non supporté
      negative_prompt: b.negative_prompt,
      test_mode: !!b.test_mode
    };

    const forwardedHeaders = {
      "Content-Type": "application/json",
    };
    // On transmet le Bearer token au besoin (ton endpoint /api/generate-gen4-image le demande)
    if (req.headers.authorization) forwardedHeaders["Authorization"] = req.headers.authorization;
    if (req.headers["idempotency-key"]) forwardedHeaders["Idempotency-Key"] = req.headers["idempotency-key"];

    const r = await fetch(url, {
      method: "POST",
      headers: forwardedHeaders,
      body: JSON.stringify(providerPayload)
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data?.ok) {
      // Normalise l’erreur côté v1
      return res.status(r.status || 500).json({
        ok: false,
        error: data?.error || "provider_failed",
        details: data
      });
    }

    // --------- Réponse v1 normalisée ----------
    // 🔒 Toujours URL Supabase (jamais replicate.delivery) — ton endpoint interne le fait déjà.
    return res.status(200).json({
      ok: true,
      job_id: data.job_id || null,
      status: data.status || "succeeded",
      image_url: data.image_url || null,
      meta: {
        prompt_final: b.prompt_final,
        prompt_negative: b.negative_prompt || null,
        preset_id: b.preset_id || null,
        preset_version: b.preset_version || null,
        guidance: b.guidance ?? null,
        prompt_strength: b.prompt_strength ?? null,
        seed: b.seed ?? null
      }
    });

  } catch (e) {
    console.error("❌ /api/v1-jobs error", e?.message || e);
    return res.status(500).json({ ok:false, error:"internal_error" });
  }
}
