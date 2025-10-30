// /api/v1/ideas/generate.mjs — FINAL INLINE (no local imports)
// Pollinations → Supabase Storage (public or signed), table ideas_examples (optional trace)
export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";

/* ---------- CORS ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ---------- ENV (server) ---------- */
const SUPABASE_URL              = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET                    = process.env.BUCKET_IMAGES || process.env.PREVIEW_BUCKET || "generated_images";
const POL_TOKEN                 = process.env.POLLINATIONS_TOKEN || "";
const OUTPUT_PUBLIC             = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S              = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30);
const CACHE_CONTROL             = String(process.env.IDEAS_CACHE_CONTROL_S || 31536000);

/* ---------- Helpers ---------- */
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

async function fetchWithTimeout(url, init, ms) {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function bufferFromPollinations({ prompt, width = 1024, height = 1024, model = "flux", timeoutMs = 60000 }) {
  const q = new URLSearchParams({
    model, width: String(width), height: String(height),
    private: "true", enhance: "true", nologo: "true"
  }).toString();
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`;
  const headers = POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {};
  const r = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`pollinations_failed ${r.status} ${r.statusText} | ${msg.slice(0,200)}`);
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  const ctype = r.headers.get("content-type") || "";
  if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype)) throw new Error(`unexpected_content_type ${ctype}`);
  return bytes;
}

function getSb() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) & SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();

  // Debug léger (sans exposer de secrets)
  if (req.method === "GET" && req.query?.debug === "1") {
    return res.status(200).json({
      ok: true,
      endpoint: "/api/v1/ideas/generate",
      has_supabase_url: Boolean(SUPABASE_URL),
      has_service_role: Boolean(SUPABASE_SERVICE_ROLE_KEY),
      bucket: BUCKET,
      output_public: OUTPUT_PUBLIC
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "method_not_allowed" });
  }

  // Body tolérant
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { slug, prompt, width = 1024, height = 1024, model = "flux" } = body || {};
  if (!slug || !prompt) return res.status(400).json({ success: false, error: "missing_slug_or_prompt" });

  const safeSlug = sanitize(slug);
  const keyPath = `ideas/${safeSlug}/${today()}/${Date.now()}.jpg`;

  // 0) Client Supabase
  let sb;
  try { sb = getSb(); }
  catch (e) { return res.status(500).json({ success: false, error: String(e.message || e) }); }

  console.log(`🧾 request | ideas.generate | slug=${safeSlug} | bucket=${BUCKET}`);

  try {
    // 1) Génération via Pollinations
    const bytes = await bufferFromPollinations({ prompt, width, height, model });
    console.log("🧪 provider.call | ok");

    // 2) Upload Storage
    const bucketCheck = await sb.storage.getBucket(BUCKET);
    if (!bucketCheck?.data) {
      return res.status(500).json({ success: false, error: "bucket_not_found", bucket: BUCKET });
    }

    const up = await sb.storage.from(BUCKET).upload(keyPath, bytes, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: CACHE_CONTROL
    });
    if (up.error) return res.status(500).json({ success: false, error: "upload_failed", details: String(up.error).slice(0,200) });

    // 3) URL publique / signée
    let imageUrl;
    if (OUTPUT_PUBLIC) {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(keyPath);
      imageUrl = data.publicUrl;
    } else {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(keyPath, SIGNED_TTL_S);
      if (error) return res.status(500).json({ success: false, error: "signed_url_failed", details: String(error).slice(0,200) });
      imageUrl = data.signedUrl;
    }
    console.log(`📦 stored | ${imageUrl}`);

    // 4) Trace (non bloquant)
    await sb.from("ideas_examples").insert({
      slug: safeSlug, image_url: imageUrl, provider: "pollinations", created_at: new Date().toISOString()
    }).catch(() => {});

    console.log("✅ succeeded | ideas.generate");
    return res.status(200).json({ success: true, slug: safeSlug, image_url: imageUrl });
  } catch (e) {
    console.error("❌ failed | ideas.generate", e);
    return res.status(500).json({ success: false, error: String(e).slice(0,200) });
  }
}
