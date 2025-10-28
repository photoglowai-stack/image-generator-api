// /api/v1-jobs.mjs
// Unique endpoint v1 : reçoit le payload standard, délègue à /api/generate-gen4-image.mjs,
// gère CORS (Origin: null pour Figma) et renvoie un JSON stable {ok, job_id, status, image_url, meta}

import unified, { MODEL_MAP } from "./generate-gen4-image.mjs";
import { createInMemoryResponse, setCORS } from "../lib/http.mjs";

const ALLOWED_MODES = new Set(["text2img", "img2img"]);
const ALLOWED_MODELS = new Set(Object.keys(MODEL_MAP));

export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    const b = req.body || {};
    // Validation minimale (le front Figma valide déjà le reste)
    if (!b?.mode || !ALLOWED_MODES.has(b.mode)) {
      return res.status(422).json({ ok:false, error:"invalid_mode" });
    }
    if (!b?.model || !ALLOWED_MODELS.has(b.model)) {
      return res.status(422).json({ ok:false, error:"invalid_model" });
    }
    if (!b?.prompt_final || typeof b.prompt_final !== "string" || b.prompt_final.length < 5) {
      return res.status(422).json({ ok:false, error:"invalid_prompt_final" });
    }
    if (b.mode === "img2img" && !b?.image_url) {
      return res.status(422).json({ ok:false, error:"image_url_required_for_img2img" });
    }

    // --------- Délégation à ta fonction unifiée existante ----------
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

    const { res: memoryRes, result } = createInMemoryResponse();
    const forwardReq = Object.create(req);
    forwardReq.method = "POST";
    forwardReq.body = providerPayload;

    await unified(forwardReq, memoryRes);
    const { statusCode, payload } = await result;

    if (!payload?.ok) {
      return res.status(statusCode || 500).json({
        ok: false,
        error: payload?.error || "provider_failed",
        details: payload,
      });
    }

    // --------- Réponse v1 normalisée ----------
    // 🔒 Toujours URL Supabase (jamais replicate.delivery) — ton endpoint interne le fait déjà.
    return res.status(200).json({
      ok: true,
      job_id: payload.job_id || null,
      status: payload.status || "succeeded",
      image_url: payload.image_url || null,
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
