// /api/credits.mjs
// Lecture & mise à jour du solde :
//   - GET  /api/credits?user_id=...                (read)
//   - POST /api/credits { user_id, op, amount }    (debit|credit|reset)
import { createClient } from "@supabase/supabase-js";

// ⚠️ Serveur uniquement : service_role
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRole) {
  // Laisser une trace claire dans les logs si variables manquantes
  console.error("❌ Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

// Helpers CORS (Figma → Vercel)
const setCORS = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // ou "https://www.figma.com" si tu veux une allowlist stricte
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const { user_id } = req.method === "GET" ? req.query : (req.body || {});
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  try {
    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("user_credits")
        .select("credits")
        .eq("user_id", user_id)
        .single();
      // PGRST116 = no rows
      if (error && error.code !== "PGRST116") throw error;
      return res.status(200).json({ success: true, user_id, credits: data?.credits ?? 0 });
    }

    if (req.method === "POST") {
      const { amount = 0, op = "debit" } = req.body || {};
      if (!["debit", "credit", "reset"].includes(op)) {
        return res.status(400).json({ error: "op must be 'debit', 'credit' or 'reset'" });
      }

      // Upsert si inexistant
      const { data: row, error: upsertErr } = await supabase
        .from("user_credits")
        .upsert({ user_id, credits: 0 }, { onConflict: "user_id" })
        .select()
        .single();
      if (upsertErr) throw upsertErr;

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
      if (updErr) throw updErr;

      return res.status(200).json({ success: true, user_id, credits: newCredits, op });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("❌ /api/credits error:", e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || "internal_error" });
  }
}
