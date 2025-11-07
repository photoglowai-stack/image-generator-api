// /api/v1/ideas/generate.mjs — FINAL INLINE (single bucket, with category fields, BUCKET_IDEAS priority)
// Pollinations → Supabase Storage (public or signed), table ideas_examples (optional trace)
export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";

/* ---------- CORS ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("content-type", "application/json");
}

/* ---------- ENV (server) ---------- */
const SUPABASE_URL              = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Bucket DÉDIÉ à cette route (on ignore BUCKET_IMAGES ici)
// Priorité: BUCKET_IDEAS > BUCKET_GALLERY > "ai_gallery"
const BUCKET = process.env.BUCKET_IDEAS || process.env.BUCKET_GALLERY || "ai_gallery";

// Visibilité unique : public (URL directe) ou privé (URL signée)
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC ?? "true") === "true";

const POL_TOKEN     = process.env.POLLINATIONS_TOKEN || "";
const SIGNED_TTL_S  = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30);
const CACHE_CONTROL = String(process.env.IDEAS_CACHE_CONTROL_S || 31536000);

/* ---------- Helpers ---------- */
const sanitize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);
const clamp = (n, min, max) => Math.max(min, Math.min(max, Math.floor(n || 0)));

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
  // borne les tailles pour éviter les abus / erreurs provider
  const W = clamp(width, 64, 1792);
  const H = clamp(height, 64, 1792);

  const q = new URLSearchParams({
    model, width: String(W), height: String(H),
    private: "true", enhance: "true", nologo: "true"
  }).toString();

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`;
  const headers = {
    ...(POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {}),
    "Accept": "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.8",
    "User-Agent": "Photoglow-API/ideas-generator"
  };

  const r = await fetchWithTimeout(url, { headers }, timeoutMs);

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`pollinations_failed ${r.status} ${r.statusText} | ${msg.slice(0,200)}`);
  }

  const ctype = (r.headers.get("content-type") || "").toLowerCase();
  if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype)) {
    const msg = await r.text().catch(() => "");
    throw new Error(`unexpected_content_type ${ctype || "(empty)"} | ${msg.slice(0,200)}`);
  }

  const bytes = Buffer.from(await r.arrayBuffer());
  const norm = /image\/(jpeg|jpg)/i.test(ctype) ? "image/jpeg"
            : /image\/png/i.test(ctype)          ? "image/png"
            : /image\/webp/i.test(ctype)         ? "image/webp"
            : "application/octet-stream";
  return { bytes, ctype: norm };
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
      output_public: OUTPUT_PUBLIC,
      bucket_env_values: {
        BUCKET_IDEAS: process.env.BUCKET_IDEAS || null,
        BUCKET_GALLERY: process.env.BUCKET_GALLERY || null,
        BUCKET_IMAGES: process.env.BUCKET_IMAGES || null
      },
      bucket_selected_precedence: "BUCKET_IDEAS > BUCKET_GALLERY > 'ai_gallery' (BUCKET_IMAGES ignored in this route)"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "method_not_allowed" });
  }

  // Body tolérant
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const {
    slug,
    prompt,
    width = 1024,
    height = 1024,
    model = "flux",
    persist = false,          // false => previews/, true => outputs/ (dans le même bucket)
    collection,

    // ---- champs catégories (facultatifs) ----
    category_id,              // ex: "ai-headshots"
    prompt_index,             // ex: 1, 2, 3...
    prompt_title,             // ex: "Studio corporate"
    prompt_text,              // ex: "professional corporate headshot..."
    aspect_ratio              // ex: "1:1" | "3:4" | ...
  } = body || {};

  if (!slug || !prompt) {
    return res.status(400).json({ success: false, error: "missing_slug_or_prompt" });
  }

  const sb = (() => {
    try { return getSb(); }
    catch (e) { throw new Error(String(e?.message || e)); }
  })();

  const safeSlug = sanitize(slug);
  const coll     = collection ? sanitize(collection) : "";
  const baseFolder = persist
    ? (coll ? `outputs/${coll}`  : "outputs")
    : (coll ? `previews/${coll}` : "previews");

  console.log(`🧾 request | ideas.generate | slug=${safeSlug} | bucket=${BUCKET} | persist=${persist}`);

  try {
    // 1) Génération via Pollinations
    const { bytes, ctype } = await bufferFromPollinations({ prompt, width, height, model });
    console.log("🧪 provider.call | ok");

    // extension selon content-type
    const ext = ctype === "image/png" ? "png" : ctype === "image/webp" ? "webp" : "jpg";
    const keyPath = `${baseFolder}/ideas/${safeSlug}/${today()}/${Date.now()}.${ext}`;

    // 2) Upload Storage
    const bucketCheck = await sb.storage.getBucket(BUCKET);
    if (!bucketCheck?.data) {
      return res.status(500).json({ success: false, error: "bucket_not_found", bucket: BUCKET });
    }

    const up = await sb.storage.from(BUCKET).upload(keyPath, bytes, {
      contentType: ctype || "image/jpeg",
      upsert: true,
      cacheControl: CACHE_CONTROL
    });
    if (up?.error) {
      return res.status(500).json({ success: false, error: "upload_failed", details: String(up.error).slice(0,200) });
    }

    // 3) URL publique / signée (unique)
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

    // 4) Trace (non bloquant) — tentative enrichie (catégories) puis fallback minimal
    const traceEnriched = {
      slug: safeSlug,
      image_url: imageUrl,
      provider: "pollinations",
      bucket: BUCKET,
      key_path: keyPath,
      persist,
      // ---- champs catégories ----
      prompt_title: prompt_title || null,
      prompt_text:  prompt_text  || prompt || null,
      category_id:  category_id  || null,
      prompt_index: Number.isFinite(+prompt_index) ? +prompt_index : null,
      aspect_ratio: aspect_ratio || null,
      created_at: new Date().toISOString()
    };

    let traceError = null;
    try {
      const ins = await sb.from("ideas_examples").insert(traceEnriched);
      if (ins?.error) traceError = ins.error;
    } catch (e) {
      traceError = e;
    }

    if (traceError) {
      console.warn("db_insert_failed_enriched, retry_minimal", traceError);
      try {
        await sb.from("ideas_examples").insert({
          slug: safeSlug,
          image_url: imageUrl,
          provider: "pollinations",
          created_at: new Date().toISOString()
        });
      } catch (e) {
        console.warn("db_insert_failed_minimal", e);
      }
    }

    console.log("✅ succeeded | ideas.generate");
    return res.status(200).json({
      success: true,
      slug: safeSlug,
      image_url: imageUrl,
      bucket: BUCKET,
      persist
    });
  } catch (e) {
    console.error("❌ failed | ideas.generate", e);
    return res.status(500).json({ success: false, error: String(e).slice(0,200) });
  }
}
