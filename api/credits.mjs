// /api/credits.mjs
// GET  /api/credits?health=1          → healthcheck (aucun accès DB)
// GET  /api/credits?user_id=...       → lecture crédits
// POST /api/credits { user_id, op, amount } → debit|credit|reset
import { createClient } from "@supabase/supabase-js";

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // durcis plus tard
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SERVICE_ROLE) {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    // 0) HEALTHCHECK SANS DB (doit répondre 200 si la route est bien chargée)
    if (req.method === "GET" && (req.query?.health === "1")) {
      return res.status(200).json({
        ok: true,
        runtime: "node",
        has_env: { SUPABASE_URL: !!SUPABASE_URL, SERVICE_ROLE: !!SERVICE_ROLE }
      });
    }

    // 1) GARDE-FOUS ENV EXPLICITES (évite le crash silencieux)
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).json({
        success: false,
        error: "missing_env",
        detail: {
          SUPABASE_URL: !!SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: !!SERVICE_ROLE
        }
      });
    }

    const { user_id } = req.method === "GET" ? req.query : (req.body || {});
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("user_credits")
        .select("credits")
        .eq("user_id", user_id)
        .single();

      // PGRST116 = no rows → renvoyer 0 plutôt que crasher
      if (error && error.code !== "PGRST116") {
        return res.status(500).json({ success: false, error: error.message, code: error.code });
      }

      return res.status(200).json({
        success: true,
        user_id,
        credits: data?.credits ?? 0
      });
    }

    if (req.method === "POST") {
      const { amount = 0, op = "debit" } = req.body || {};
      if (!["debit", "credit", "reset"].includes(op)) {
        return res.status(400).json({ error: "op must be 'debit', 'credit' or 'reset'" });
      }

      const { data: row, error: upsertErr } = await supabase
        .from("user_credits")
        .upsert({ user_id, credits: 0 }, { onConflict: "user_id" })
        .select()
        .single();
      if (upsertErr) {
        return res.status(500).json({ success: false, error: upsertErr.message, code: upsertErr.code });
      }

      let newCredits = row.credits;

      if (op === "debit") {
        if (!Number.isInteger(amount) || amount <= 0)
          return res.status(400).json({ error: "amount must be positive int" });
        if (row.credits < amount)
          return res.status(402).json({ success: false, error: "insufficient_credits", credits: row.credits });
        newCredits = row.credits - amount;
      } else if (op === "credit") {
        if (!Number.isInteger(amount) || amount <= 0)
          return res.status(400).json({ error: "amount must be positive int" });
        newCredits = row.credits + amount;
      } else if (op === "reset") {
        newCredits = 0;
      }

      const { error: updErr } = await supabase
        .from("user_credits")
        .update({ credits: newCredits, updated_at: new Date().toISOString() })
        .eq("user_id", user_id);
      if (updErr) {
        return res.status(500).json({ success: false, error: updErr.message, code: updErr.code });
      }

      return res.status(200).json({ success: true, user_id, credits: newCredits, op });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    // Ne jamais laisser tomber → toujours renvoyer du JSON
    return res.status(500).json({ success: false, error: e?.message || "internal_error" });
  }
}
