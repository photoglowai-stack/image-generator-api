// /api/v1/ideas/generate.mjs — FINAL (Pollinations → Supabase Storage, import robuste /lib/supabase.mjs)
export const config = { runtime: "nodejs" };

/* ---------- CORS ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ---------- ENV ---------- */
const POL_TOKEN     = process.env.POLLINATIONS_TOKEN || "";
const BUCKET        = process.env.PREVIEW_BUCKET || process.env.BUCKET_IMAGES || "generated_images"; // ← conforme à ta doc
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S  = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30);
const CACHE_CONTROL = String(process.env.IDEAS_CACHE_CONTROL_S || 31536000);

/* ---------- Helpers ---------- */
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const today = () => new Date().toISOString().slice(0,10);

async function fetchWithTimeout(url, init, ms) {
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort('timeout'), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function bufferFromPollinations({ prompt, width = 1024, height = 1024, model = "flux", timeoutMs = 60000 }) {
  const q = new URLSearchParams({
    model, width: String(width), height: String(height),
    private: "true", enhance: "true", nologo: "true",
  }).toString();
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`;
  const headers = POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {};
  const r = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!r.ok) {
    const msg = await r.text().catch(()=> "");
    throw new Error(`pollinations_failed ${r.status} ${r.statusText} | ${msg.slice(0,200)}`);
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  const ctype = r.headers.get('content-type') || '';
  if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype)) throw new Error(`unexpected_content_type ${ctype}`);
  return bytes;
}

/* ---------- Robust dynamic import of /lib/supabase.mjs (avec fallback) ---------- */
// Ton /lib/supabase.mjs exporte getSupabaseServiceRole() et ensureSupabaseClient() :contentReference[oaicite:0]{index=0}
async function loadSupabaseModule() {
  const candidates = [
    "../../../lib/supabase.mjs", // ← chemin attendu depuis /api/v1/ideas/
    "../../lib/supabase.mjs",    // fallback si l'arbo a varié
    "../../../supabase.mjs"      // fallback si le fichier est à la racine
  ];
  let lastErr;
  for (const rel of candidates) {
    try {
      const mod = await import(new URL(rel, import.meta.url));
      if (mod?.getSupabaseServiceRole && mod?.ensureSupabaseClient) {
        return { mod, resolved: rel };
      }
    } catch (e) { lastErr = e; }
  }
  throw new Error(`supabase_module_load_failed: ${String(lastErr).slice(0,200)}`);
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();

  // Debug non-sensible : confirme le chemin résolu et la présence des ENV (sans leak)
  if (req.method === "GET" && req.query?.debug === "1") {
    try {
      const { mod, resolved } = await loadSupabaseModule();
      const sb = mod.getSupabaseServiceRole();
      mod.ensureSupabaseClient(sb, "service");
      return res.status(200).json({
        ok: true,
        endpoint: "/api/v1/ideas/generate",
        resolved_supabase_mjs: resolved,
        has_supabase_url: true,
        has_service_role: true,
        bucket: BUCKET,
        output_public: OUTPUT_PUBLIC
      });
    } catch {
      return res.status(200).json({
        ok: true,
        endpoint: "/api/v1/ideas/generate",
        resolved_supabase_mjs: null,
        has_supabase_url: false,
        has_service_role: false,
        bucket: BUCKET,
        output_public: OUTPUT_PUBLIC
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success:false, error:"method_not_allowed" });
  }

  // Import dynamique Supabase (même pattern que tes autres endpoints)
  let sb;
  try {
    const { mod } = await loadSupabaseModule();
    const { ensureSupabaseClient, getSupabaseServiceRole } = mod;
    sb = getSupabaseServiceRole();          // lit SUPABASE_URL + SERVICE_ROLE depuis process.env
    ensureSupabaseClient(sb, "service");    // throws si manquant (propre) :contentReference[oaicite:1]{index=1}
  } catch (e) {
    return res.status(500).json({ success:false, error:"missing_env_supabase_or_module", details: String(e).slice(0,200) });
  }

  // Body tolérant
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body) } catch { body = {} } }
  const { slug, prompt, width = 1024, height = 1024, model = "flux" } = body || {};
  if (!slug || !prompt) return res.status(400).json({ success:false, error:"missing_slug_or_prompt" });

  const safeSlug = sanitize(slug);
  const path = `ideas/${safeSlug}/${today()}/${Date.now()}.jpg`;

  console.log(`🧾 request | ideas.generate | slug=${safeSlug} | bucket=${BUCKET}`);

  try {
    // 1) Génération via Pollinations
    const bytes = await bufferFromPollinations({ prompt, width, height, model });
    console.log("🧪 provider.call | ok");

    // 2) Upload Storage (bucket doit exister : "generated_images" d'après ta doc) :contentReference[oaicite:2]{index=2}
    const bucketCheck = await sb.storage.getBucket(BUCKET);
    if (!bucketCheck?.data) {
      return res.status(500).json({ success:false, error:"bucket_not_found", bucket: BUCKET });
    }

    const up = await sb.storage.from(BUCKET).upload(path, bytes, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: CACHE_CONTROL,
    });
    if (up.error) return res.status(500).json({ success:false, error:"upload_failed", details: String(up.error).slice(0,200) });

    // 3) URL publique / signée
    let imageUrl;
    if (OUTPUT_PUBLIC) {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      imageUrl = data.publicUrl;
    } else {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_S);
      if (error) return res.status(500).json({ success:false, error:"signed_url_failed", details: String(error).slice(0,200) });
      imageUrl = data.signedUrl;
    }
    console.log(`📦 stored | ${imageUrl}`);

    // 4) Trace (table conseillée dans ta doc : photos_meta / ou ideas_examples si tu l’as) :contentReference[oaicite:3]{index=3}
    await sb.from("ideas_examples").insert({
      slug: safeSlug, image_url: imageUrl, provider: "pollinations", created_at: new Date().toISOString()
    }).catch(()=>{}); // non bloquant

    console.log("✅ succeeded | ideas.generate");
    return res.status(200).json({ success:true, slug: safeSlug, image_url: imageUrl });
  } catch (e) {
    console.error("❌ failed | ideas.generate", e);
    return res.status(500).json({ success:false, error:String(e).slice(0,200) });
  }
}
