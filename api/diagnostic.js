// /api/diagnostic.js
// Diagnostic JSON (toujours) : DB read, Storage write test, existence bucket "photos"
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

export default async function handler(req, res) {
  try {
    // force JSON
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const checks = [];

    // 1) DB read test (photos_meta)
    try {
      const { error } = await supabase.from("photos_meta").select("id").limit(1);
      checks.push({ key: "db_photos_meta_read", ok: !error, error: error?.message || null });
    } catch (e) {
      checks.push({ key: "db_photos_meta_read", ok: false, error: String(e?.message || e) });
    }

    // 2) Storage write test (generated_images)
    try {
      const key = `diagnostics/${Date.now()}.txt`;
      const blob = new Blob([`ok:${new Date().toISOString()}`], { type: "text/plain" });
      const { error } = await supabase.storage.from("generated_images").upload(key, blob, { upsert: false, cacheControl: "60" });
      if (error) throw error;
      const { data } = supabase.storage.from("generated_images").getPublicUrl(key);
      checks.push({ key: "storage_generated_images_write", ok: true, url: data.publicUrl });
    } catch (e) {
      checks.push({ key: "storage_generated_images_write", ok: false, error: String(e?.message || e) });
    }

    // 3) Bucket photos existence (sans lister — juste construire une URL)
    try {
      const { data } = supabase.storage.from("photos").getPublicUrl("health/ghost.txt");
      if (!data?.publicUrl) throw new Error("no_public_url");
      checks.push({ key: "storage_photos_bucket_exists", ok: true });
    } catch (e) {
      checks.push({ key: "storage_photos_bucket_exists", ok: false, error: String(e?.message || e) });
    }

    const ok = checks.every(c => c.ok);
    return res.status(ok ? 200 : 500).json({ ok, checks });
  } catch (e) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
