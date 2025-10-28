import { MODEL_MAP } from "./generate-gen4-image.mjs";

const LABELS = {
  flux: "Flux 1.1 Pro",
  gen4: "Runway Gen-4",
  "gen4-turbo": "Gen-4 Turbo",
};

export default async function handler(req, res) {
  const models = Object.entries(MODEL_MAP).map(([id, value]) => ({
    id,
    name: LABELS[id] || id,
    value,
  }));

  res.json({
    success: true,
    models,
  });
}
