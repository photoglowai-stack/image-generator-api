// /api/credits.mjs
// GET  /api/credits?health=1        → healthcheck (pas d'auth requise)
// GET  /api/credits                 → lire le solde (auth Bearer obligatoire)
// POST /api/credits {op, amount?}   → debit|credit|reset (auth Bearer obligatoire)

import { createClient } from "@supabase/supabase-js";

// ---------- CORS ----------
function setCORS(res) {
  // Pour débug, on autorise tout. Quand tout marche, remplace par process.env.FRONT_ORIGIN.
  const origin = process.env.FRONT_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, idempotency-key"
  );
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

// Deux clients :
// - supabaseAuth (ANON) pour vérifier le JWT de l'utilisateur
// - supabaseAdmin (SERVICE ROLE) pour lire/écrire (RPC, tables)
const supabaseAuth = (SUPABASE_URL && ANON_KEY)
  ? createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  : null;

const supabaseAdmin = (SUPABASE_URL && SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // --- Healthcheck sans auth ---
  if (req.method === "GET" && (req.query?.health === "1" || req.query?.health === 1)) {
    return res.status(200).json({
      ok: true,
      has_env: {
        SUPABASE_URL: !!SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: !!SERVICE_ROLE,
        SUPABASE_ANON_KEY: !!ANON_KEY
      }
    });
  }

  if (!supabaseAuth || !supabaseAdmin) {
    return res.status(500).json({ success: false, error: "missing_env" });
  }

  // --- Auth Bearer ---
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

  const { data: userData, error: authErr } = await supabaseAuth.auth.getUser(token);
  if (authErr || !userData?.user) {
    return res.status(401).json({ success: false, error: "invalid_token" });
  }
  const user_id = userData.user.id;

  // --- GET: lire le solde ---
  if (req.method === "GET") {
    const { data: row, error: selErr } = await supabaseAdmin
      .from("user_credits")
      .select("credits")
      .eq("user_id", user_id)
      .maybeSingle();

    if (selErr) {
      return res.status(500).json({ success: false, error: selErr.message });
    }

    // Si pas de ligne → initialise à 0
    if (!row) {
      const { error: insErr } = await supabaseAdmin
        .from("user_credits")
        .insert({ user_id, credits: 0 });
      if (insErr) return res.status(500).json({ success: false, error: insErr.message });
      return res.status(200).json({ success: true, user_id, credits: 0 });
    }

    return res.status(200).json({ success: true, user_id, credits: row.credits });
  }

  // --- POST: op = debit | credit | reset ---
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
          if (String(error.message).includes("no_credits_row")) {
            return res.status(402).json({ success: false, error: "no_credits_row" });
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

      // Relire le solde après opération
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
