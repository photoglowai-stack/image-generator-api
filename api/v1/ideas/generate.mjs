// /api/v1/ideas/generate.mjs — Ideas Generator (Pollinations-aligned)
export const config = { runtime: "nodejs" };

/* ---------- CORS (inline) ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*"); // Figma (Origin: null) OK
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ---------- ENV (mêmes patterns que v1-preview) ---------- */
const POL_TOKEN      = process.env.POLLINATIONS_TOKEN || ""; // optionnel
const BUCKET         = process.env.BUCKET_IMAGES || "generated"; // 👈 même nom que ta capture
const OUTPUT_PUBLIC  = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S   = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30);
const CACHE_CONTROL  = String(process.env.IDEAS_CACHE_CONTROL_S || 31536000);

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
  if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype)) {
    throw new Error(`unexpected_content_type ${ctype}`);
  }
  return bytes;
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();

  // ✅ Debug: vérifie au runtime que les ENV sont bien vues (sans révéler de secrets)
  if (req.method === "GET" && req.query?.debug === "1") {
    try {
      const mod = await import("../../supabase.mjs"); // depuis /api/v1/ideas/
      const sb = mod?.getSupabaseServiceRole?.();
      mod?.ensureSupabaseClient?.(sb, "service");
      return res.status(200).json({
        ok: true, endpoint: "/api/v1/ideas/generate",
        has_supabase_url: true, has_service_role: true, bucket: BUCKET, output_public: OUTPUT_PUBLIC
      });
    } catch {
      return res.status(200).json({
        ok: true, endpoint: "/api/v1/ideas/generate",
        has_supabase_url: false, has_service_role: false, bucket: BUCKET, output_public: OUTPUT_PUBLIC
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success:false, error:"method_not_allowed" });
  }

  // Import dynamique (exactement comme v1-preview)
  let sb;
  try {
    const { ensureSupabaseClient, getSupabaseServiceRole } = await import("../../supabase.mjs");
    sb = getSupabaseServiceRole();
    ensureSupabaseClient(sb, "service");
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
    // 1) Génération via Pollinations (même que preview)
    const bytes = await bufferFromPollinations({ prompt, width, height, model });
    console.log("🧪 provider.call | ok");

    // 2) Upload Storage
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

    // 4) Trace en BDD
    const ins = await sb.from("ideas_examples").insert({
      slug: safeSlug, image_url: imageUrl, provider: "pollinations", created_at: new Date().toISOString()
    });
    if (ins.error) return res.status(500).json({ success:false, error:"db_insert_failed", details: String(ins.error).slice(0,200) });

    console.log("✅ succeeded | ideas.generate");
    return res.status(200).json({ success:true, slug: safeSlug, image_url: imageUrl });
  } catch (e) {
    console.error("❌ failed | ideas.generate", e);
    return res.status(500).json({ success:false, error:String(e).slice(0,200) });
  }
}
