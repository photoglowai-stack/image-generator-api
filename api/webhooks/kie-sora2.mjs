// /api/webhooks/kie-sora2.mjs
export const config = { runtime: "nodejs" };

import { randomUUID, createHmac } from "crypto";
import { setCORS } from "../lib/http.mjs";
import { getSupabaseServiceRole, ensureSupabaseClient } from "../lib/supabase.mjs";

const supabaseAdmin = getSupabaseServiceRole(); ensureSupabaseClient(supabaseAdmin,"service");

const TABLE = process.env.TABLE_VIDEOS_META || "videos_meta";
const BUCKET_VIDEOS = process.env.BUCKET_VIDEOS || "videos";
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC || "true")==="true";
const WEBHOOK_SECRET = process.env.WEBHOOK_SHARED_SECRET || "change-me";

async function download(url){
  const r = await fetch(url); if(!r.ok) throw new Error(`dl ${r.status}`);
  const ct = r.headers.get("content-type") || "video/mp4";
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = ct.includes("webm") ? ".webm" : ".mp4";
  return { buf, ct, ext };
}

export default async function handler(req, res){
  setCORS(req, res, { allowMethods:"POST,OPTIONS" });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false });

  try {
    // Vérif HMAC facultative (si Kie envoie un header stable, sinon token de requête)
    const jobId = req.query?.job_id || null;
    if (!jobId) return res.status(422).json({ ok:false, error:"missing_job_id" });

    const body = req.body || {};
    // attendu: { taskId, status: "success"|"fail"|"generating", videoUrl? }
    if (body.status !== "success" || !body.videoUrl) {
      await supabaseAdmin.from(TABLE).update({ status: body.status || "processing" }).eq("id", jobId);
      return res.status(200).json({ ok:true, noop:true });
    }

    const { buf, ct, ext } = await download(body.videoUrl);
    const key = `outputs/${new Date().toISOString().slice(0,10)}/${randomUUID()}${ext}`;
    const up = await supabaseAdmin.storage.from(BUCKET_VIDEOS).upload(key, buf, { contentType: ct, upsert:false });
    if (up.error) throw up.error;

    let url = null;
    if (OUTPUT_PUBLIC) {
      const { data } = supabaseAdmin.storage.from(BUCKET_VIDEOS).getPublicUrl(key);
      url = data?.publicUrl || null;
    } else {
      const { data, error } = await supabaseAdmin.storage.from(BUCKET_VIDEOS).createSignedUrl(key, 60*60*24*7);
      if (error) throw error; url = data?.signedUrl || null;
    }

    await supabaseAdmin.from(TABLE).update({
      status:"completed",
      video_url: url,
      updated_at: new Date().toISOString()
    }).eq("id", jobId);

    return res.status(200).json({ ok:true, video_url: url });

  } catch (e) {
    console.error("webhook-sora2", e);
    return res.status(500).json({ ok:false, error:"webhook_failed" });
  }
}
