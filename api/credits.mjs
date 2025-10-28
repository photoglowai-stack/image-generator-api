// /api/credits.mjs
// GET  /api/credits?health=1        → healthcheck (pas d'auth requise)
// GET  /api/credits                 → lire le solde (auth Bearer obligatoire)
// POST /api/credits {op, amount?, target_user_id?, target_email?}
//     op ∈ debit|credit|reset|set
//   - non-admin: debit|reset sur lui-même uniquement
//   - admin (email ∈ ADMIN_EMAILS): debit|credit|reset|set sur soi ou une cible

export const config = { runtime: "nodejs" };

import { setCORS } from "../lib/http.mjs";
import {
  ensureSupabaseClient,
  getSupabaseAnon,
  getSupabaseServiceRole,
} from "../lib/supabase.mjs";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map(s => s.trim().toLowerCase());

// Clients Supabase
const supabaseAuth = getSupabaseAnon();
const supabaseAdmin = getSupabaseServiceRole();

// Résoudre un user_id à partir d'un email (Admin API)
async function resolveUserIdByEmail(email) {
  const { data: page1, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 500 });
  if (error) throw error;
  const hit = (page1?.users || []).find(
    u => (u.email || "").toLowerCase() === String(email).toLowerCase()
  );
  return hit?.id || null;
}

export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Healthcheck
  if (req.method === "GET" && (req.query?.health === "1" || req.query?.health === 1)) {
    return res.status(200).json({
      ok: true,
      has_env: {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY || !!process.env.SERVICE_ROLE,
        SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY
      }
    });
  }

  if (!supabaseAuth || !supabaseAdmin) {
    return res.status(500).json({ success: false, error: "missing_env" });
  }

  ensureSupabaseClient(supabaseAuth, "anon");
  ensureSupabaseClient(supabaseAdmin, "service");

  // --- Auth Bearer (utilisateur courant) ---
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

  const { data: userData, error: authErr } = await supabaseAuth.auth.getUser(token);
  if (authErr || !userData?.user) {
    return res.status(401).json({ success: false, error: "invalid_token" });
  }
  const requester_id = userData.user.id;
  const requester_email = (userData.user.email || "").toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(requester_email);

  // --- GET: lire le solde du demandeur ---
  if (req.method === "GET") {
    const { data: row, error: selErr } = await supabaseAdmin
      .from("user_credits")
      .select("credits")
      .eq("user_id", requester_id)
      .maybeSingle();

    if (selErr) {
      return res.status(500).json({ success: false, error: selErr.message });
    }

    // Si pas de ligne → initialise à 0
    if (!row) {
      const { error: insErr } = await supabaseAdmin
        .from("user_credits")
        .insert({ user_id: requester_id, credits: 0 });
      if (insErr) return res.status(500).json({ success: false, error: insErr.message });
      return res.status(200).json({ success: true, user_id: requester_id, credits: 0 });
    }

    return res.status(200).json({ success: true, user_id: requester_id, credits: row.credits });
  }

  // --- POST: opérations ---
  if (req.method === "POST") {
    const { op = "debit", amount = 1, target_user_id, target_email } = req.body || {};
    if (!["debit", "credit", "reset", "set"].includes(op)) {
      return res.status(400).json({ success: false, error: "invalid_op" });
    }

    // Détermination de la cible
    let targetId = requester_id;
    if (isAdmin && (target_user_id || target_email)) {
      targetId = target_user_id || await resolveUserIdByEmail(target_email);
      if (!targetId) return res.status(404).json({ success: false, error: "user_not_found" });
    } else if (!isAdmin && (target_user_id || target_email)) {
      return res.status(403).json({ success: false, error: "forbidden_target" });
    }

    try {
      if (op === "debit") {
        const { error } = await supabaseAdmin.rpc("debit_credits", {
          p_user_id: targetId, p_amount: amount
        });
        if (error) {
          const msg = String(error.message || "");
          if (msg.includes("insufficient_credits")) {
            return res.status(402).json({ success: false, error: "insufficient_credits" });
          }
          if (msg.includes("no_credits_row")) {
            return res.status(402).json({ success: false, error: "no_credits_row" });
          }
          return res.status(500).json({ success: false, error: msg });
        }
      } else if (op === "credit") {
        if (!isAdmin && targetId !== requester_id) {
          return res.status(403).json({ success: false, error: "forbidden" });
        }
        const { error } = await supabaseAdmin.rpc("credit_credits", {
          p_user_id: targetId, p_amount: amount
        });
        if (error) return res.status(500).json({ success: false, error: error.message });
      } else if (op === "reset") {
        const { error } = await supabaseAdmin
          .from("user_credits")
          .upsert({ user_id: targetId, credits: 0 }, { onConflict: "user_id" });
        if (error) return res.status(500).json({ success: false, error: error.message });
      } else if (op === "set") {
        if (!isAdmin) return res.status(403).json({ success: false, error: "forbidden" });
        const { error } = await supabaseAdmin
          .from("user_credits")
          .upsert({ user_id: targetId, credits: Number(amount || 0) }, { onConflict: "user_id" });
        if (error) return res.status(500).json({ success: false, error: error.message });
      }

      // Relire le solde après opération
      const { data: row2, error: sel2 } = await supabaseAdmin
        .from("user_credits")
        .select("credits")
        .eq("user_id", targetId)
        .maybeSingle();
      if (sel2) return res.status(500).json({ success: false, error: sel2.message });

      return res.status(200).json({
        success: true, user_id: targetId, credits: row2?.credits ?? 0, op
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  }

  return res.status(405).json({ success: false, error: "method_not_allowed" });
}
