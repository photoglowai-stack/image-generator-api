// /api/credits.mjs
// GET  /api/credits?health=1        → healthcheck
// GET  /api/credits                 → lecture crédits (user du token)
// POST /api/credits {op, amount?}   → debit|credit|reset (user du token)
import { createClient } from "@supabase/supabase-js";

function setCORS(res) {
  // Durcis si tu veux: "https://www.figma.com"
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

  try {
    // 1) Auth: extraire le user à partir du token
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

    const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !userData?.user) {
      return res.status(401).json({ success: false, error: "invalid_token" });
    }
    const user_id = userData.user.id; // UUID

    if (req.method === "GET") {
      // Upsert silencieux à 0 pour que la 1ère lecture retourne 0
      await supabaseAdmin
        .from("user_credits")
        .upsert({ user_id, credits: 0 }, { onConflict: "user_id" });

      const { data, error } = await supabaseAdmin
        .from("user_credits")
        .select("credits")
        .eq("user_id", user_id)
        .single();
      if (error) return res.status(500).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, user_id, credits: data.credits });
    }

    if (req.method === "POST") {
      const { op = "debit", amount = 1 } = req.body || {};
      if (!["debit", "credit", "reset"].includes(op)) {
        return res.status(400).json({ error: "op must be 'debit', 'credit' or 'reset'" });
      }

      let credits = 0;

      if (op === "debit") {
        const { data, error } = await supabaseAdmin.rpc("debit_credits", {
          p_user_id: user_id,
          p_amount: amount
        });
        if (error) {
          if (String(error.message).includes("insufficient_credits")) {
            return res.status(402).json({ success: false, error: "insufficient_credits" });
          }
          return res.status(500).json({ success: false, error: error.message });
        }
        credits = data;
      } else if (op === "credit") {
        const { data, error } = await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id,
          p_amount: amount
        });
        if (error) return res.status(500).json({ success: false, error: error.message });
        credits = data;
      } else if (op === "reset") {
        const { error } = await supabaseAdmin
          .from("user_credits")
          .update({ credits: 0, updated_at: new Date().toISOString() })
          .eq("user_id", user_id);
        if (error) return res.status(500).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true, user_id, credits, op });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e?.message || "internal_error" });
  }
}
