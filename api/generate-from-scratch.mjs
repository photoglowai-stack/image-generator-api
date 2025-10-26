// /api/generate-from-scratch.mjs  — proxy propre vers la route réelle
export const config = { runtime: "nodejs" };

import handlerReal from "./generate-gen4-image.mjs";

export default async function handler(req, res) {
  // Par compat : si aucun modèle n’est donné, on force Flux text2img
  if (req.method === "POST") {
    try {
      if (!req.body || typeof req.body !== "object") {
        req.body = {};
      }
      if (!req.body.model && !req.body.model_path) {
        req.body.model = "flux"; // Flux 1.1 Pro
      }
      if (!req.body.mode) {
        req.body.mode = "text2img";
      }
    } catch {}
  }
  return handlerReal(req, res);
}
