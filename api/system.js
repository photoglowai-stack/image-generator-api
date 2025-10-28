// --- Endpoint health/diagnostic ---
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const isPing = req.url.endsWith("/system") && (req.query?.ping !== undefined || req.method === "HEAD");
  if (isPing) return res.status(200).json({ ok: true, msg: "pong" });
  if (req.url.endsWith("/ping")) return res.status(200).json({ ok: true, msg: "pong" });

  try {
    // Récupérer les informations d'environnement et valider les clients Supabase
    const env = getSupabaseEnv();
    ensureSupabaseClient(supabaseAdmin, "service");
    ensureSupabaseClient(supabaseAnon, "anon");

    const checks = [];

    // 1) DB read test (photos_meta)
    if (supabaseAnon) {
      try {
        const { error } = await supabaseAnon.from("photos_meta").select("id").limit(1);
        checks.push({ key: "db_photos_meta", ok: !error, error: error?.message || null });
      } catch (e) {
        checks.push({ key: "db_photos_meta", ok: false, error: String(e?.message || e) });
      }
    } else {
      checks.push({ key: "db_photos_meta", ok: false, error: "missing_supabase_anon_client" });
    }

    // 2) Vérification des Buckets avec admin
    if (supabaseAdmin) {
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
    } else {
      checks.push({ key: "buckets_list", ok: false, error: "missing_supabase_service_client" });
    }

    // Retourner la réponse avec le résultat de tous les checks
    const ok = checks.every(c => c.ok);
    const payload = {
      ok,
      env: { BUCKET_UPLOADS, BUCKET_IMAGES, supabase: env },
      checks
    };

    if (!supabaseAdmin) {
      payload.note = "storage_verification_unavailable";
    }

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
}
