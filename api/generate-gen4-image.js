// /api/generate-gen4-image.js
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { withCors } from "../lib/cors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { withRequestLogging } from "../lib/logger.js";
import { beginIdempotent, endIdempotent } from "../lib/idempotency.js";
// Optionnel compression
// import { maybeCompressJPEG } from "../lib/images.js";

const rl = rateLimit({ windowMs:60_000, max:60 });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false } });
const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

const B64_JPEG_1x1 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEA8QDw8PDw8PDw8PDw8PDw8PDw8PFREWFhURGyggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGi0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAABAgME/8QAFxABAQEBAAAAAAAAAAAAAAAAAQIDAP/aAAwDAQACEQMRAD8A4kYAAAAA//Z";

function todayISODate(){ const d=new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; }
async function fetchAsBuffer(url){ const r=await fetch(url); if(!r.ok) throw new Error(`download_failed_${r.status}`); return Buffer.from(await r.arrayBuffer()); }
async function uploadToSupabasePublic(buffer, path){
  const { error } = await supabase.storage.from("generated_images").upload(path, buffer, { contentType:"image/jpeg", cacheControl:"31536000", upsert:false });
  if (error) throw error;
  const { data } = supabase.storage.from("generated_images").getPublicUrl(path);
  return data.publicUrl;
}
async function insertMeta(row){ const { error } = await supabase.from("photos_meta").insert(row); if (error) console.warn("⚠️ insert photos_meta failed:", error.message); }

async function core(req, res, ctx) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success:false, error:"Method not allowed" });
  if (!rl(req, res)) return; // 429 sent

  const idempotencyKey = req.headers["idempotency-key"];
  let user_id = null; // à renseigner quand tu passeras à l’auth côté site

  if (idempotencyKey && user_id) {
    const idem = await beginIdempotent({ key:idempotencyKey, user_id, route:"/api/generate-gen4-image" });
    if (!idem.proceed) return res.status(200).json(idem.replay);
  }

  const { log, start } = ctx;
  const body = req.body || {};
  const { prompt, aspect_ratio="16:9", num_outputs=1, source="api-gen4", test_mode=false, category="ai-headshots", model="runwayml/gen4-image" } = body;

  if (!prompt && !test_mode) return res.status(400).json({ success:false, error:"Missing prompt" });
  if (!test_mode && (!REPLICATE_API_TOKEN || REPLICATE_API_TOKEN === "")) {
    return res.status(500).json({ success:false, error:"replicate_token_missing" });
  }

  const dateSlug = todayISODate();
  const batch_id = randomUUID();
  const receivedAt = new Date().toISOString();
  const n = Math.min(Math.max(parseInt(num_outputs,10)||1,1),4);
  const items = [];

  // TEST MODE
  if (test_mode) {
    for (let i=0;i<n;i++){
      const fileId = randomUUID();
      const buf = Buffer.from(B64_JPEG_1x1, "base64");
      const path = `categories/${category}/outputs/${dateSlug}/${fileId}.jpg`;
      const publicUrl = await uploadToSupabasePublic(buf, path);
      await insertMeta({ created_at:receivedAt, prompt, category, source, image_url:publicUrl, mode:"gen4-test", batch_id, input_url:null, output_path:path, model, duration_ms:1, user_id });
      items.push({ prompt, image_url:publicUrl, replicate_url:null, prediction_id:"test-mode", duration_ms:1 });
    }
    const resp = { success:true, mode:"gen4-test", category, batch_id, count:items.length, duration_ms: Date.now()-start, items };
    if (idempotencyKey && user_id) await endIdempotent({ key:idempotencyKey, success:true, response_json: resp });
    return res.status(200).json(resp);
  }

  // PROD MODE
  log("info", { msg:"🧪 provider.call", provider:"replicate", model });
  let pred = await replicate.predictions.create({ model, input: { prompt, aspect_ratio, num_outputs:n } });
  while (["queued","starting","processing"].includes(pred.status)) { await new Promise(r=>setTimeout(r,1000)); pred = await replicate.predictions.get(pred.id); }
  if (pred.status !== "succeeded") { const resp={ success:false, error:`replicate_failed_${pred.status}` }; if (idempotencyKey && user_id) await endIdempotent({ key:idempotencyKey, success:false, response_json:resp }); return res.status(502).json(resp); }

  const outs = Array.isArray(pred.output) ? pred.output : [pred.output];
  for (const u of outs) {
    if (typeof u !== "string") continue;
    const fileId = randomUUID();
    const buf = await fetchAsBuffer(u);
    // Optionnel : compression
    // const jpeg = await maybeCompressJPEG(buf);
    const jpeg = buf;
    const path = `categories/${category}/outputs/${dateSlug}/${fileId}.jpg`;
    const publicUrl = await uploadToSupabasePublic(jpeg, path);
    await insertMeta({
      created_at: receivedAt, prompt, category, source, image_url: publicUrl, mode: "gen4", batch_id,
      input_url: null, output_path: path, model,
      duration_ms: pred.metrics?.predict_time ? Math.round(pred.metrics.predict_time*1000) : null,
      user_id
    });
    items.push({ prompt, image_url: publicUrl, replicate_url: u, prediction_id: pred.id, duration_ms: pred.metrics?.predict_time ? Math.round(pred.metrics.predict_time*1000) : null });
  }

  const resp = { success:true, mode:"gen4", category, batch_id, count: items.length, duration_ms: Date.now()-start, items };
  if (idempotencyKey && user_id) await endIdempotent({ key:idempotencyKey, success:true, response_json: resp });
  return res.status(200).json(resp);
}

export default withCors(withRequestLogging(core));
