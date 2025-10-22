// /api/credits.js
// Gestion unifiée des crédits utilisateurs : lecture, ajout, retrait, reset
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("⚠️ Missing SUPABASE_URL or SUPABASE_ANON_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

/*
🧱 Table attendue :
  public.user_credits (
    user_id text primary key,
    credits integer not null default 0,
    updated_at timestamptz not null default now()
  )
*/

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const { user_id } = req.method === "GET" ? req.query : (req.body || {});
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  try {
    // 🔍 Lecture du solde actuel
    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("user_credits")
        .select("credits")
        .eq("user_id", user_id)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return res.status(200).json({ success: true, user_id, credits: data?.credits ?? 0 });
    }

    // ✍️ Mise à jour (crédit / débit / reset)
    if (req.method === "POST") {
      const { amount = 0, op = "debit" } = req.body || {};
      if (!["debit", "credit", "reset"].includes(op)) {
        return res.status(400).json({ error: "op must be 'debit', 'credit' or 'reset'" });
      }

      // Vérifier ou créer l'utilisateur
      const { data: row, error: upsertErr } = await supabase
        .from("user_credits")
        .upsert({ user_id, credits: 0 }, { onConflict: "user_id" })
        .select()
        .single();
      if (upsertErr) throw upsertErr;

      let newCredits = row.credits;
      if (op === "debit") {
        if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
        if (row.credits < amount)
          return res.status(402).json({ success: false, error: "insufficient_credits", credits: row.credits });
        newCredits = row.credits - amount;
      } else if (op === "credit") {
        if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
        newCredits = row.credits + amount;
      } else if (op === "reset") {
        newCredits = 0;
      }

      const { error: updErr } = await supabase
        .from("user_credits")
        .update({ credits: newCredits, updated_at: new Date().toISOString() })
        .eq("user_id", user_id);
      if (updErr) throw updErr;

      return res.status(200).json({ success: true, user_id, credits: newCredits, op });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("❌ /api/credits error:", e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || "internal_error" });
  }
}
