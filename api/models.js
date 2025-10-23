export default async function handler(req, res) {
  res.json({
    success: true,
    models: [
      { id: "flux", name: "Flux 1.1 Pro", value: "black-forest-labs/flux-1.1-pro" },
      { id: "gen4", name: "Runway Gen-4", value: "runwayml/gen4-image" },
      { id: "turbo", name: "Gen-4 Turbo", value: "runwayml/gen4-image-turbo" }
    ]
  });
}
