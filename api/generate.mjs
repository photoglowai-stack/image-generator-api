// /api/generate.mjs
// Version simplifiée (simulation, pas d'appel Replicate réel)

import { createClient } from "@supabase/supabase-js";

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, endpoint: "img2img" });

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return res.status(401).json({ success: false, error: "invalid_token" });
  const user_id = userData.user.id;

  // Simulation débit crédits
  const debit = await supabase.rpc("debit_credits", { p_user_id: user_id, p_amount: 1 });
  if (debit.error) {
    if (String(debit.error.message).includes("insufficient_credits")) {
      return res.status(402).json({ success: false, error: "insufficient_credits" });
    }
    return res.status(500).json({ success: false, error: debit.error.message });
  }

  // Écrit une fausse entrée
  await supabase.from("photos_meta").insert({
    prompt: "img2img test",
    source: "curl-sim",
    mode: "img2img",
    duration_ms: 50,
    user_id
  });

  return res.status(200).json({
    success: true,
    message: "🧪 simulation OK — crédits débités",
    endpoint: "img2img"
  });
}
