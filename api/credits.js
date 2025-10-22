// /api/credits.js
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

/*
Schema minimal conseillé:
table public.user_credits (
  user_id text primary key,
  credits integer not null default 0,
  updated_at timestamptz not null default now()
)
Policies proto:
  SELECT/UPDATE/INSERT public (à durcir plus tard)
*/

export default async function handler(req, res) {
  try {
    const { user_id } = req.method === "GET" ? req.query : (req.body || {});
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    if (req.method === "GET") {
      const { data, error } = await supabase.from("user_credits").select("credits").eq("user_id", user_id).single();
      if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
      const credits = data?.credits ?? 0;
      return res.status(200).json({ success: true, user_id, credits });
    }

    if (req.method === "POST") {
      const { amount = 0, op = "debit" } = req.body || {};
      if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: "amount must be positive int" });

      // upsert row
      const { data: row, error: upErr } = await supabase
        .from("user_credits")
        .upsert({ user_id, credits: 0 }, { onConflict: "user_id" })
        .select()
        .single();
      if (upErr) return res.status(500).json({ error: upErr.message });

      let newCredits = row.credits;
      if (op === "debit") {
        if (row.credits < amount) return res.status(402).json({ success: false, error: "insufficient_credits", credits: row.credits });
        newCredits = row.credits - amount;
      } else if (op === "credit") {
        newCredits = row.credits + amount;
      } else {
        return res.status(400).json({ error: "op must be 'debit' or 'credit'" });
      }

      const { error: updErr } = await supabase.from("user_credits").update({ credits: newCredits }).eq("user_id", user_id);
      if (updErr) return res.status(500).json({ error: updErr.message });
      return res.status(200).json({ success: true, user_id, credits: newCredits });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("❌ /api/credits error:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
}
