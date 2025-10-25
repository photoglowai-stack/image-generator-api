// /api/system.js
// GET /api/system?ping  → {ok:true,msg:"pong"}
// GET /api/system       → diagnostic JSON (DB + buckets)

import { createClient } from "@supabase/supabase-js";

// --- Config buckets depuis ENV (avec valeurs par défaut) ---
export const BUCKET_UPLOADS  = process.env.BUCKET_UPLOADS  || "photos";
export const BUCKET_IMAGES   = process.env.BUCKET_IMAGES   || "generated_images";

// --- Clients Supabase ---
// Admin (service role) : nécessaire pour listBuckets / opérations serveur
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE,
  { auth: { persistSession: false } }
);

// Public (anon) : lecture simple côté app
export const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: true } }
);

// --- Helpers Storage réutilisables ailleurs (importables depuis ./api/system.js) ---
export async function uploadBufferToBucket(bucket, path, buffer, contentType = "image/jpeg") {
  const { data, error } = await supabaseAdmin
    .storage
    .from(bucket)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
  return data; // { path, id }
}

export function getPublicUrl(bucket, path) {
  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

export async function getSignedUrl(bucket, path, expiresInSec = 3600) {
  const { data, error } = await supabaseAdmin
    .storage
    .from(bucket)
    .createSignedUrl(path, expiresInSec);
  if (error) throw error;
  return data.signedUrl;
}

// Raccourcis projet
export const uploadUserPhoto = (userId, filename, buffer) =>
  uploadBufferToBucket(BUCKET_UPLOADS, `${userId}/raw/${filename}`, buffer);

export const saveGeneratedImage = (userId, jobId, buffer) =>
  uploadBufferToBucket(BUCKET_IMAGES, `${userId}/generated/${jobId}.png`, buffer);

// --- Endpoint health/diagnostic ---
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const isPing = req.url.endsWith("/system") && (req.query?.ping !== undefined || req.method === "HEAD");
  if (isPing) return res.status(200).json({ ok: true, msg: "pong" });
  if (req.url.endsWith("/ping")) return res.status(200).json({ ok: true, msg: "pong" });

  try {
    const checks = [];

    // 1) DB read test (photos_meta)
    try {
      const { error } = await supabaseAnon.from("photos_meta").select("id").limit(1);
      checks.push({ key: "db_photos_meta", ok: !error, error: error?.message || null });
    } catch (e) {
      checks.push({ key: "db_photos_meta", ok: false, error: String(e?.message || e) });
    }

    // 2) Buckets: on liste via admin (service role), puis on vérifie les 2 noms ENV
    try {
      const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
      if (error) throw error;

      const names = (buckets || []).map(b => b.name);
      checks.push({
        key: "bucket_uploads",
        expected: BUCKET_UPLOADS,
        ok: names.includes(BUCKET_UPLOADS),
        available: names
      });
      checks.push({
        key: "bucket_generated",
        expected: BUCKET_IMAGES,
        ok: names.includes(BUCKET_IMAGES)
      });
    } catch (e) {
      checks.push({ key: "buckets_list", ok: false, error: String(e?.message || e) });
    }

    return res.status(200).json({
      ok: checks.every(c => c.ok),
      env: { BUCKET_UPLOADS, BUCKET_IMAGES },
      checks
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
}
