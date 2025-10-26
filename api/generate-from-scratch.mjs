// /api/generate-from-scratch.mjs — alias de compatibilité (Flux par défaut)
export const config = { runtime: "nodejs" };
import unified from "./generate-gen4-image.mjs";

export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const body = (req.body && typeof req.body === "object") ? req.body : {};
      req.body = {
        mode: body.mode || "text2img",
        model: body.model || "flux",
        ...body,
      };
    } catch { /* ignore */ }
  }
  return unified(req, res);
}
