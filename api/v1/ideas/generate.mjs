// /api/v1/ideas/generate.mjs — Production-ready (idempotence, retries, HQ defaults)
// Pollinations → Supabase Storage (public or signed), trace ideas_examples
// STORAGE: ai_gallery/categories/<slug>/<file> (no date, no collection)
// Metrics: Server-Timing, x-processing-ms, JSON metrics
export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

/* ---------- CORS ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    opts.allowHeaders || "content-type, authorization, idempotency-key"
  );
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("content-type", "application/json");
}

/* ---------- Response helpers ---------- */
function sendJSON(res, status, obj) {
  try {
    if (typeof res.status === "function" && typeof res.json === "function") {
      return res.status(status).json(obj);
    }
  } catch {}
  res.statusCode = status;
  if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}
function endStatus(res, status = 204) {
  try {
    if (typeof res.status === "function" && typeof res.end === "function") {
      return res.status(status).end();
    }
  } catch {}
  res.statusCode = status;
  res.end();
}

/* ---------- ENV ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Priorité: BUCKET_IDEAS > BUCKET_GALLERY > "ai_gallery"
const BUCKET = process.env.BUCKET_IDEAS || process.env.BUCKET_GALLERY || "ai_gallery";

// URL publique (true) vs signée (false)
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC ?? "true") === "true";

// Pollinations
const POL_TOKEN = process.env.POLLINATIONS_TOKEN || "";
const POL_TIMEOUT_MS = Number(process.env.POLLINATIONS_TIMEOUT_MS || 60000);

// Storage
const SIGNED_TTL_S = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30);
const CACHE_CONTROL = String(process.env.IDEAS_CACHE_CONTROL_S || 31536000);

// Layout (persist / previews)
const OUTPUTS_ROOT = "categories";
const PREVIEWS_ROOT = "previews";
const ADD_DATE_SUBFOLDER = false;

// Divers
const MAX_DIM = Number(process.env.POLLINATIONS_MAX_DIM || 1792);
const MIN_PROVIDER_PIXELS = Number(process.env.MIN_PROVIDER_PIXELS || 3_000_000);

// Time budget (Vercel)
const MAX_FUNCTION_S  = Number(process.env.MAX_FUNCTION_S || 25);
const SAFETY_MARGIN_S = 3;
function timeBudgetMs() {
  return Math.max(5000, (MAX_FUNCTION_S - SAFETY_MARGIN_S) * 1000);
}

/* ---------- Helpers ---------- */
const sanitize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const clamp = (n, min, max) => Math.max(min, Math.min(max, Math.floor(n || 0)));

function parseAspectRatio(ratio) {
  if (!ratio || typeof ratio !== "string") return null;
  const m = ratio.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (!w || !h) return null;
  return { w, h };
}

function fitByAspect({ width, height, aspect_ratio }) {
  const ar = parseAspectRatio(aspect_ratio);
  // défaut rapide 1024
  let W = clamp(width || 1024, 64, MAX_DIM);
  let H = clamp(height || 1024, 64, MAX_DIM);
  if (ar) {
    if (width && !height) H = clamp(Math.round((W * ar.h) / ar.w), 64, MAX_DIM);
    if (!width && height) W = clamp(Math.round((H * ar.w) / ar.h), 64, MAX_DIM);
  }
  return { W, H };
}

async function fetchWithTimeout(url, init, ms) {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

/* ---------- Sniffer dimensions ---------- */
function sniffImageSize(buf) {
  try {
    // PNG
    if (buf.slice(0,8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG (SOF0/SOF2)
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i+1];
        const len = buf.readUInt16BE(i+2);
        if (marker === 0xC0 || marker === 0xC2) {
          const h = buf.readUInt16BE(i+5);
          const w = buf.readUInt16BE(i+7);
          return { width: w, height: h };
        }
        i += 2 + len;
      }
    }
    // WEBP (RIFF/WEBP VP8X)
    if (buf.slice(0,4).toString() === "RIFF" && buf.slice(8,12).toString() === "WEBP") {
      const idx = buf.indexOf(Buffer.from("VP8X"));
      if (idx > 0) {
        const w = 1 + (buf[idx+12] | (buf[idx+13]<<8) | (buf[idx+14]<<16));
        const h = 1 + (buf[idx+15] | (buf[idx+16]<<8) | (buf[idx+17]<<16));
        if (w>0 && h>0) return { width: w, height: h };
      }
    }
  } catch {}
  return null;
}

/* ---------- Provider: Pollinations (alias /p + fallback /prompt) ---------- */
async function callPollinations({
  prompt,
  width = 1024,
  height = 1024,
  model = "flux",
  timeoutMs = POL_TIMEOUT_MS,
  seed
}) {
  const W = clamp(width, 64, MAX_DIM);
  const H = clamp(height, 64, MAX_DIM);
  const enhance = "false"; // + rapide/stable en sync

  const headers = {
    ...(POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {}),
    Accept: "image/png,image/jpeg,*/*;q=0.5",
    "User-Agent": "Photoglow-API/ideas-generator",
  };

  async function tryFetch(u) {
    const r = await fetchWithTimeout(u, { headers }, timeoutMs);
    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      throw new Error(`pollinations_failed ${r.status} ${r.statusText} | ${msg.slice(0,200)}`);
    }
    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    if (!/image\/(png|jpeg|jpg|webp)/i.test(ctype)) {
      const msg = await r.text().catch(() => "");
      throw new Error(`unexpected_content_type ${ctype || "(empty)"} | ${msg.slice(0,200)}`);
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    const dims = sniffImageSize(bytes) || {};
    const norm =
      /image\/png/i.test(ctype) ? "image/png" :
      /image\/webp/i.test(ctype) ? "image/webp" :
      /image\/(jpeg|jpg)/i.test(ctype) ? "image/jpeg" : "application/octet-stream";
    return { bytes, ctype: norm, provider_w: dims.width || null, provider_h: dims.height || null };
  }

  // seed anti-cache
  const s = String(seed ?? Math.floor(Math.random() * 1e9));

  // 1) Alias rapide /p
  const uP =
    `https://pollinations.ai/p/${encodeURIComponent(prompt)}` +
    `?model=${encodeURIComponent(model)}&width=${W}&height=${H}&enhance=${enhance}&nologo=true&private=true&seed=${s}`;

  // 2) Fallback /prompt
  const uPrompt =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?model=${encodeURIComponent(model)}&width=${W}&height=${H}&enhance=${enhance}&nologo=true&private=true&seed=${s}`;

  // Essai /p, puis /prompt si échec
  let out = null, err1 = null;
  try { out = await tryFetch(uP); }
  catch (e) { err1 = e; }

  if (!out) {
    try { out = await tryFetch(uPrompt); }
    catch (e2) { throw new Error(`pollinations_both_failed | p:${String(err1).slice(0,160)} | prompt:${String(e2).slice(0,160)}`); }
  }

  // Seuil qualité dynamique: min(MIN_PROVIDER_PIXELS, ~100% W*H)
  const targetPx = W * H;
  const minPx = Math.min(MIN_PROVIDER_PIXELS, Math.floor(targetPx * 0.98));
  const ok = out.provider_w && out.provider_h && (out.provider_w * out.provider_h >= minPx);
  if (!ok) {
    // Retry une seconde fois avec nouvelle seed (anti-cache)
    try {
      const s2 = String(Math.floor(Math.random() * 1e9));
      const u2 = uP.replace(/seed=\d+/, `seed=${s2}`);
      out = await tryFetch(u2);
    } catch {}
  }
  return out;
}

function getSb() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) & SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function shortHash(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  const t0 = Date.now();
  let tIdem = 0, tProv = 0, tUp = 0;

  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return endStatus(res, 204);

  // Debug
  if (req.method === "GET" && (req.query?.debug === "1" || (typeof req.url === "string" && req.url.includes("debug=1")))) {
    return sendJSON(res, 200, {
      ok: true,
      endpoint: "/api/v1/ideas/generate",
      has_supabase_url: Boolean(SUPABASE_URL),
      has_service_role: Boolean(SUPABASE_SERVICE_ROLE_KEY),
      bucket: BUCKET,
      output_public: OUTPUT_PUBLIC,
      path_policy: {
        outputs_root: OUTPUTS_ROOT,
        previews_root: PREVIEWS_ROOT,
        add_date_subfolder: String(ADD_DATE_SUBFOLDER),
        lock: true,
        persist_ignores_collection: true
      },
      pollinations_timeout_ms: POL_TIMEOUT_MS,
      max_dim: MAX_DIM,
      min_provider_pixels: MIN_PROVIDER_PIXELS,
      now: new Date().toISOString()
    });
  }

  if (req.method !== "POST") {
    return sendJSON(res, 405, { success: false, error: "method_not_allowed" });
  }

  // Body tolérant
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const {
    slug,
    prompt,
    width,
    height,
    model = "flux",
    persist = false,
    // facultatifs (trace)
    category_id,
    prompt_index,
    prompt_title,
    prompt_text,
    aspect_ratio,
    style,
  } = body || {};

  if (!slug || !prompt) {
    return sendJSON(res, 400, { success: false, error: "missing_slug_or_prompt" });
  }

  const sb = (() => {
    try { return getSb(); }
    catch (e) { return sendJSON(res, 500, { success: false, error: String(e?.message || e) }); }
  })();
  if (!sb) return;

  // Dimensions
  const { W, H } = fitByAspect({ width, height, aspect_ratio });

  // Idempotence (clé => nom de fichier)
  const IDEM = (req.headers["idempotency-key"] || "").toString().slice(0, 160);
  const safeSlug = sanitize(slug);

  // Folders
  const root = persist ? OUTPUTS_ROOT : PREVIEWS_ROOT;
  const folder = `${root}/${safeSlug}`;

  // BaseId (idempotency-key prioritaire sinon hash)
  const baseId =
    IDEM ||
    `${safeSlug}-${shortHash(
      `${category_id || ""}|${style || ""}|${prompt_title || ""}|${prompt_text || prompt}|${W}x${H}|${model}|${aspect_ratio || ""}|${persist}`
    )}`;

  console.log(`🧾 request | ideas.generate | slug=${safeSlug} | folder=${folder} | baseId=${baseId} | ${W}x${H}`);

  try {
    // 0) Bucket check
    const bucketCheck = await sb.storage.getBucket(BUCKET);
    if (!bucketCheck?.data) {
      return sendJSON(res, 500, { success: false, error: "bucket_not_found", bucket: BUCKET });
    }

    // 1) Idempotence côté storage
    if (persist) {
      const tA = Date.now();
      const { data: list, error: listErr } = await sb.storage.from(BUCKET).list(folder, { search: baseId, limit: 100 });
      tIdem += Date.now() - tA;

      if (!listErr && Array.isArray(list)) {
        const found = list.find((f) => f.name === `${baseId}.jpg` || f.name === `${baseId}.png` || f.name === `${baseId}.webp`);
        if (found) {
          const keyPathExisting = `${folder}/${found.name}`;
          const imageUrl = OUTPUT_PUBLIC
            ? sb.storage.from(BUCKET).getPublicUrl(keyPathExisting).data.publicUrl
            : (await sb.storage.from(BUCKET).createSignedUrl(keyPathExisting, SIGNED_TTL_S)).data.signedUrl;

          const total = Date.now() - t0;
          res.setHeader("server-timing", `idem;dur=${tIdem}, total;dur=${total}`);
          res.setHeader("x-processing-ms", String(total));
          return sendJSON(res, 200, {
            success: true,
            slug: safeSlug,
            image_url: imageUrl,
            bucket: BUCKET,
            persist,
            idempotent: true,
            metrics: { total_ms: total, idem_ms: tIdem, provider_ms: 0, upload_ms: 0, idempotent: true }
          });
        }
      }
    }

    // 2) Appel provider (respect du time budget)
    const tP0 = Date.now();
    const providerTimeout = Math.max(4000, timeBudgetMs() - 1500);
    const { bytes, ctype, provider_w, provider_h } = await callPollinations({
      prompt, width: W, height: H, model, timeoutMs: providerTimeout
    });
    tProv += Date.now() - tP0;
    console.log("🧪 provider.call | ok", provider_w, "x", provider_h, "| bytes=", bytes.length);

    // 3) Nom final (extension réelle)
    const ext =
      ctype === "image/png" ? "png" :
      ctype === "image/webp" ? "webp" :
      ctype === "image/jpeg" ? "jpg" : "jpg";
    const keyPath = `${folder}/${baseId}.${ext}`;

    // 4) Upload Storage
    const tU0 = Date.now();
    const up = await sb.storage.from(BUCKET).upload(keyPath, bytes, {
      contentType: ctype || "image/jpeg",
      upsert: true,
      cacheControl: CACHE_CONTROL,
    });
    tUp += Date.now() - tU0;

    if (up?.error) {
      return sendJSON(res, 500, { success: false, error: "upload_failed", details: String(up.error).slice(0, 200) });
    }

    // 5) URL publique / signée
    const imageUrl = OUTPUT_PUBLIC
      ? sb.storage.from(BUCKET).getPublicUrl(keyPath).data.publicUrl
      : (await sb.storage.from(BUCKET).createSignedUrl(keyPath, SIGNED_TTL_S)).data.signedUrl;

    console.log(`📦 stored | ${imageUrl}`);

    // 6) Trace DB (non bloquant)
    const trace = {
      slug: safeSlug,
      image_url: imageUrl,
      provider: "pollinations",
      bucket: BUCKET,
      key_path: keyPath,
      persist,
      style: style || null,
      prompt_title: prompt_title || null,
      prompt_text: prompt_text || prompt || null,
      category_id: category_id || null,
      prompt_index: Number.isFinite(+prompt_index) ? +prompt_index : null,
      aspect_ratio: aspect_ratio || null,
      width: W,
      height: H,
      model_used: model,
      created_at: new Date().toISOString(),
    };
    try { await sb.from("ideas_examples").insert(trace); } catch (e) {
      console.warn("db_insert_failed", e);
    }

    const total = Date.now() - t0;
    res.setHeader("server-timing", `idem;dur=${tIdem}, provider;dur=${tProv}, upload;dur=${tUp}, total;dur=${total}`);
    res.setHeader("x-processing-ms", String(total));
    return sendJSON(res, 200, {
      success: true,
      slug: safeSlug,
      image_url: imageUrl,
      bucket: BUCKET,
      persist,
      metrics: {
        total_ms: total,
        idem_ms: tIdem,
        provider_ms: tProv,
        upload_ms: tUp,
        idempotent: false,
        image_bytes: bytes.length,
        ctype,
        provider_w,
        provider_h
      }
    });
  } catch (e) {
    console.error("❌ failed | ideas.generate", e);
    return sendJSON(res, 500, { success: false, error: String(e).slice(0, 200) });
  }
}
