// /api/system.js
// /api/system?ping => health simple
// /api/system      => diagnostic JSON (DB + buckets)
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const path = req.url.split("?")[0];
  if (path.endsWith("/system") && (req.query?.ping !== undefined || req.method === "HEAD")) {
    return res.status(200).json({ ok: true, msg: "pong" });
  }
  if (path.endsWith("/ping")) {
    // compat éventuelle si tu avais /api/ping mappé ici
    return res.status(200).json({ ok: true, msg: "pong" });
  }

  try {
    const checks = [];

    // DB read test
    try {
      const { error } = await supabase.from("photos_meta").select("id").limit(1);
      checks.push({ key: "db_photos_meta", ok: !error, error: error?.message || null });
    } catch (e) {
      checks.push({ key: "db_photos_meta", ok: false, error: String(e?.message || e) });
    }

    // Buckets existence (sans listBuckets)
    for (const b of ["photos", "generated_images"]) {
      try {
        const { data } = supabase.storage.from(b).getPublicUrl("health/ghost.txt");
        if (!data?.publicUrl) throw new Error("no_public_url");
        checks.push({ key: `bucket_${b}`, ok: true });
      } catch (e) {
        checks.push({ key: `bucket_${b}`, ok: false, error: String(e?.message || e) });
      }
    }

    return res.status(200).json({ ok: checks.every(c => c.ok), checks });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
}
