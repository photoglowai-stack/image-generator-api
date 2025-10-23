// /api/credits.mjs
// GET  /api/credits?health=1        → healthcheck
// GET  /api/credits                 → lecture crédits (sans reset !)
// POST /api/credits {op, amount?}   → debit|credit|reset (user du token)

import { createClient } from "@supabase/supabase-js";

function setCORS(res) {
  // Durcis si tu veux: process.env.FRONT_ORIGIN
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = SUPABASE_URL && SERVICE_ROLE
  ? createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Health
  if (req.method === "GET" && req.query?.health === "1") {
    return res.status(200).json({
      ok: true,
      has_env: { SUPABASE_URL: !!SUPABASE_URL, SERVICE_ROLE: !!SERVICE_ROLE }
    });
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, error: "missing_env" });
  }

  // --- Auth: extraire le user depuis le JWT (Bearer)
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

  const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !userData?.user) {
    return res.status(401).json({ success: false, error: "invalid_token" });
  }
  const user_id = userData.user.id;

  // --- GET: lire le solde sans le réinitialiser ---
  if (req.method === "GET") {
    // lire
    const { data: row, error: selErr } = await supabaseAdmin
      .from("user_credits")
      .select("credits")
      .eq("user_id", user_id)
      .maybeSingle();

    if (selErr) {
      // .maybeSingle() ne devrait pas planter, mais on sécurise
      return res.status(500).json({ success: false, error: selErr.message });
    }

    // si pas de ligne → l'initialiser à 0 une seule fois
    if (!row) {
      const { error: insErr } = await supabaseAdmin
        .from("user_credits")
        .insert({ user_id, credits: 0 });
      if (insErr) return res.status(500).json({ success: false, error: insErr.message });
      return res.status(200).json({ success: true, user_id, credits: 0 });
    }

    return res.status(200).json({ success: true, user_id, credits: row.credits });
  }

  // --- POST: op = credit | debit | reset ---
  if (req.method === "POST") {
    const { op = "debit", amount = 1 } = req.body || {};
    if (!["debit", "credit", "reset"].includes(op)) {
      return res.status(400).json({ success: false, error: "invalid_op" });
    }

    try {
      if (op === "debit") {
        const { error } = await supabaseAdmin.rpc("debit_credits", {
          p_user_id: user_id, p_amount: amount
        });
        if (error) {
          if (String(error.message).includes("insufficient_credits")) {
            return res.status(402).json({ success: false, error: "insufficient_credits" });
          }
          return res.status(500).json({ success: false, error: error.message });
        }
      } else if (op === "credit") {
        const { error } = await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id, p_amount: amount
        });
        if (error) return res.status(500).json({ success: false, error: error.message });
      } else if (op === "reset") {
        const { error } = await supabaseAdmin
          .from("user_credits")
          .upsert({ user_id, credits: 0 }, { onConflict: "user_id" });
        if (error) return res.status(500).json({ success: false, error: error.message });
      }

      // relire le solde après l'op
      const { data: row2, error: sel2 } = await supabaseAdmin
        .from("user_credits")
        .select("credits")
        .eq("user_id", user_id)
        .maybeSingle();
      if (sel2) return res.status(500).json({ success: false, error: sel2.message });

      return res.status(200).json({
        success: true, user_id, credits: row2?.credits ?? 0, op
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  }

  return res.status(405).json({ success: false, error: "method_not_allowed" });
}
