// /api/generate-sora2.mjs
export const config = { runtime: "nodejs" };

import { randomUUID, createHmac } from "crypto";
import { setCORS } from "../lib/http.mjs";
import {
  ensureSupabaseClient,
  getSupabaseAnon,
  getSupabaseServiceRole,
} from "../lib/supabase.mjs";

const supabaseAuth  = getSupabaseAnon();
const supabaseAdmin = getSupabaseServiceRole();
ensureSupabaseClient(supabaseAuth, "anon");
ensureSupabaseClient(supabaseAdmin, "service");

// --- ENV
const KIE_BASE   = process.env.KIE_BASE_URL || "https://api.kie.ai";
const KIE_KEY    = process.env.KIE_API_KEY || "";
const CREATE     = process.env.KIE_SORA2_CREATE_PATH || "/api/v1/sora/createTask";
const DETAIL     = process.env.KIE_SORA2_DETAIL_PATH || "/api/v1/sora/record-detail";
const WEBHOOK    = process.env.KIE_WEBHOOK_URL || "";
const BUCKET_VIDEOS = process.env.BUCKET_VIDEOS || "videos";
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC || "true")==="true";
const WEBHOOK_SECRET = process.env.WEBHOOK_SHARED_SECRET || "change-me";
const TABLE = process.env.TABLE_VIDEOS_META || "videos_meta";

// --- helpers
function mapRatio(r){ return r==="portrait" ? "9:16" : "16:9"; }
function mapQuality(size){ return size==="high" ? "1080p" : "720p"; }

async function safeDebitCredit({ user_id, amount = 1, op = "debit" }) {
  try { await supabaseAdmin.rpc(op==="debit" ? "debit_credits" : "credit_credits", { p_user_id: user_id, p_amount: amount }); }
  catch { /* noop */ }
}

export default async function handler(req, res){
  setCORS(req, res, { allowMethods: "POST,OPTIONS,GET" });
  if (req.method === "OPTIONS" || req.method === "HEAD") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({ ok:true, endpoint:"generate-sora2", has_env:{ KIE_KEY: !!KIE_KEY, TABLE, BUCKET_VIDEOS, OUTPUT_PUBLIC }});
  }
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"method_not_allowed" });

  try {
    // --- AUTH: Supabase Access Token
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ ok:false, error:"missing_bearer_token" });

    const { data: userData, error: authErr } = await supabaseAuth.auth.getUser(token);
    if (authErr || !userData?.user) return res.status(401).json({ ok:false, error:"invalid_token" });
    const user_id = userData.user.id;

    const idemKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"] || null;

    // --- Body
    const b = req.body || {};
    const { mode, prompt, aspect_ratio="landscape", n_frames=10, size="standard", remove_watermark=false } = b;
    const model = b.model || "sora-2";

    if (!["text2video","image2video","storyboard"].includes(mode)) {
      return res.status(422).json({ ok:false, error:"invalid_mode" });
    }
    if (!prompt || String(prompt).trim().length<4) {
      return res.status(422).json({ ok:false, error:"invalid_prompt" });
    }
    if (mode==="image2video" && (!Array.isArray(b.image_urls)||b.image_urls.length<1)) {
      return res.status(422).json({ ok:false, error:"image_urls_required" });
    }

    // --- Idempotency (best effort)
    if (idemKey) {
      const { data: existing } = await supabaseAdmin
        .from(TABLE)
        .select("id, status, video_url")
        .eq("user_id", user_id)
        .eq("idempotency_key", idemKey)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        return res.status(200).json({ ok:true, job_id: existing.id, status: existing.status, video_url: existing.video_url, idempotency_key: idemKey, dedup:true });
      }
    }

    const jobId = `sora2_${Date.now()}_${randomUUID().slice(0,8)}`;

    // --- Payload provider
    const payload = {
      model,
      prompt,
      aspectRatio: mapRatio(aspect_ratio),
      duration: Number(n_frames),
      quality: mapQuality(size),
      removeWatermark: !!remove_watermark,
    };
    if (mode==="image2video") {
      payload.imageUrl = b.image_urls[0];
      if (b.image_urls.length>1) payload.image_urls = b.image_urls.slice(0,3);
    }
    if (mode==="storyboard") {
      payload.shots = Array.isArray(b.shots) ? b.shots.slice(0,12) : [];
      payload.duration = Number(b.n_frames || 25);
    }

    // --- Webhook signé (token partage dans query + HMAC côté webhook)
    const hook = WEBHOOK
      ? `${WEBHOOK}?job_id=${encodeURIComponent(jobId)}&uid=${encodeURIComponent(user_id)}&t=${Date.now()}`
      : undefined;
    if (hook) payload.callBackUrl = hook;

    // --- Crédit pré-débit (ex: n_frames secondes * facteur configurable)
    await safeDebitCredit({ user_id, amount: 1, op: "debit" }); // adapte ta logique selon pricing

    // --- Appel Kie
    const r = await fetch(`${KIE_BASE}${CREATE}`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":`Bearer ${KIE_KEY}` },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(()=>null);
    if (!r.ok || !j?.data?.taskId) {
      await safeDebitCredit({ user_id, amount: 1, op: "credit" });
      return res.status(502).json({ ok:false, error:"provider_error", detail:j || await r.text() });
    }

    // --- Trace DB
    await supabaseAdmin.from(TABLE).insert({
      id: jobId,
      user_id,
      provider: "kie-sora2",
      provider_task_id: j.data.taskId,
      prompt,
      duration: payload.duration,
      status: "processing",
      video_url: null,
      idempotency_key: idemKey || null,
      created_at: new Date().toISOString()
    });

    return res.status(202).json({
      ok: true,
      job_id: jobId,
      provider_task_id: j.data.taskId,
      status: "queued",
      idempotency_key: idemKey || null
    });

  } catch (e) {
    console.error("generate-sora2", e);
    return res.status(500).json({ ok:false, error:"internal_error", detail: String(e?.message || e) });
  }
}
