// /api/v1/ideas/generate.mjs
// Photoglow — v1 HQ (Pollinations → Supabase Storage → URL publique/signée)
// STORAGE: ai_gallery/categories/<slug>/<file> (no date, no collection)
// Objectif: meilleure qualité que v1-preview (résolution plus élevée + enhance=true par défaut)

export const config = { runtime: "nodejs", maxDuration: 60 };

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

/* ----------------------------- CORS ----------------------------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    opts.allowHeaders || "content-type, authorization, idempotency-key"
  );
  res.setHeader("access-control-max-age", "86400");
}

/* ----------------------- Response helpers ----------------------- */
function sendJSON(res, status, obj) {
  try {
    if (typeof res.status === "function" && typeof res.json === "function") {
      return res.status(status).json(obj);
    }
  } catch {}
  res.statusCode = status;
  if (!res.getHeader("content-type")) {
    res.setHeader("content-type", "application/json");
  }
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

/* ----------------------------- ENV ------------------------------ */
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Priorité: BUCKET_IDEAS > BUCKET_GALLERY > "ai_gallery"
const BUCKET =
  process.env.BUCKET_IDEAS || process.env.BUCKET_GALLERY || "ai_gallery";

// URL publique (true) vs signée (false)
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC ?? "true") === "true";

// Pollinations
// Récupération du token depuis les variables d'env Vercel
const POL_TOKEN = process.env.POLLINATIONS_TOKEN || "";
const POL_ENHANCE = (process.env.POL_ENHANCE ?? "true") === "true"; // HQ: true par défaut
const POL_ENDPOINT_PROMPT =
  process.env.POL_ENDPOINT_PROMPT || "https://image.pollinations.ai/prompt";

// Time budget (Vercel)
// MODIFICATION ICI : On passe à 55s par défaut (maxDuration est à 60s dans vercel.json)
const MAX_FUNCTION_S = Number(process.env.MAX_FUNCTION_S || 55);
const SAFETY_MARGIN_S = 4; // laisse du temps pour upload + JSON

function timeBudgetMs() {
  return Math.max(5000, (MAX_FUNCTION_S - SAFETY_MARGIN_S) * 1000);
}

// Timeout provider : On autorise jusqu'à 45s d'attente (au lieu de 15s)
// Cela permet à l'option "Enhance" de terminer son travail HQ.
const POL_TIMEOUT_MS = Math.min(45000, timeBudgetMs() - 2000);

// Storage
const SIGNED_TTL_S = Number(
  process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30
);
const CACHE_CONTROL = String(
  process.env.IDEAS_CACHE_CONTROL_S || 31536000
);

// Résolution & qualité
const MAX_DIM = Number(process.env.POLLINATIONS_MAX_DIM || 1792); // plus haut que preview
const DEFAULT_PX = Number(process.env.GENERATE_DEFAULT_PX || 1536); // base HQ
const MIN_PROVIDER_PIXELS = Number(
  process.env.MIN_PROVIDER_PIXELS || 3_000_000
);

/* ---------------------------- Helpers --------------------------- */
const sanitize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const clamp = (n, min, max) =>
  Math.max(min, Math.min(max, Math.floor(Number(n) || 0)));

function parseAspectRatio(ratio) {
  if (!ratio || typeof ratio !== "string") return null;
  const m = ratio.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!m) return null;
  const w = Number(m[1]),
    h = Number(m[2]);
  if (!w || !h) return null;
  return { w, h };
}

// Dimensions HQ (plus haut que v1-preview)
function computeDims({ width, height, aspect_ratio }) {
  const ar = parseAspectRatio(aspect_ratio);
  let W = clamp(width || DEFAULT_PX, 512, MAX_DIM);
  let H = clamp(height || DEFAULT_PX, 512, MAX_DIM);

  if (ar) {
    if (width && !height) {
      H = clamp(Math.round((W * ar.h) / ar.w), 512, MAX_DIM);
    } else if (!width && height) {
      W = clamp(Math.round((H * ar.w) / ar.h), 512, MAX_DIM);
    } else if (!width && !height) {
      // par défaut: portrait 3:4 si aspect_ratio fourni
      if (ar.h > ar.w) {
        W = clamp(DEFAULT_PX, 512, MAX_DIM);
        H = clamp(Math.round((W * ar.h) / ar.w), 512, MAX_DIM);
      } else {
        H = clamp(DEFAULT_PX, 512, MAX_DIM);
        W = clamp(Math.round((H * ar.w) / ar.h), 512, MAX_DIM);
      }
    }
  }

  return { W, H };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = POL_TIMEOUT_MS) {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ----------------- Sniffer dimensions simple -------------------- */
function sniffImageSize(buf) {
  try {
    // PNG
    if (
      buf
        .slice(0, 8)
        .equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        )
    ) {
      return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
      };
    }
    // JPEG (SOF0/SOF2)
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker === 0xc0 || marker === 0xc2) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          return { width: w, height: h };
        }
        i += 2 + len;
      }
    }
    // WEBP (RIFF/WEBP VP8X)
    if (
      buf.slice(0, 4).toString() === "RIFF" &&
      buf.slice(8, 12).toString() === "WEBP"
    ) {
      const idx = buf.indexOf(Buffer.from("VP8X"));
      if (idx > 0) {
        const w =
          1 +
          (buf[idx + 12] |
            (buf[idx + 13] << 8) |
            (buf[idx + 14] << 16));
        const h =
          1 +
          (buf[idx + 15] |
            (buf[idx + 16] << 8) |
            (buf[idx + 17] << 16));
        if (w > 0 && h > 0) return { width: w, height: h };
      }
    }
  } catch {}
  return null;
}

/* ------------------ Provider: Pollinations HQ ------------------- */
// Un seul endpoint : https://image.pollinations.ai/prompt
async function callPollinationsHQ({
  prompt,
  width,
  height,
  model = "flux",
  timeoutMs = POL_TIMEOUT_MS,
  seed,
}) {
  const W = clamp(width || DEFAULT_PX, 512, MAX_DIM);
  const H = clamp(height || DEFAULT_PX, 512, MAX_DIM);
  const enhance = POL_ENHANCE ? "true" : "false";

  const headers = {
    Accept: "image/png,image/jpeg,image/webp,*/*;q=0.5",
    "User-Agent": "Photoglow-API/generate-hq",
  };
  // Injection du token si présent
  if (POL_TOKEN) headers.Authorization = `Bearer ${POL_TOKEN}`;

  const s = seed ?? Math.floor(Math.random() * 1e9);

  const q = new URLSearchParams({
    model,
    width: String(W),
    height: String(H),
    private: "true",
    nologo: "true",
    enhance,
    nofeed: "true",
    seed: String(s),
    quality: "high",
  }).toString();

  const url = `${POL_ENDPOINT_PROMPT}/${encodeURIComponent(prompt)}?${q}`;
  const r = await fetchWithTimeout(url, { headers }, timeoutMs);

  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(
      `pollinations_failed ${r.status} ${r.statusText} | ${msg.slice(
        0,
        200
      )}`
    );
  }

  const ctype = (r.headers.get("content-type") || "").toLowerCase();
  if (!/image\/(png|jpeg|jpg|webp)/i.test(ctype)) {
    const msg = await r.text().catch(() => "");
    throw new Error(
      `unexpected_content_type ${ctype || "(empty)"} | ${msg.slice(0, 200)}`
    );
  }

  const bytes = Buffer.from(await r.arrayBuffer());
  const dims = sniffImageSize(bytes) || {};
  const norm =
    /image\/png/i.test(ctype)
      ? "image/png"
      : /image\/webp/i.test(ctype)
      ? "image/webp"
      : /image\/(jpeg|jpg)/i.test(ctype)
      ? "image/jpeg"
      : "application/octet-stream";

  const provider_w = dims.width || null;
  const provider_h = dims.height || null;

  // Check "soft" de qualité (log seulement)
  const targetPx = W * H;
  const minPx = Math.min(
    MIN_PROVIDER_PIXELS,
    Math.floor(targetPx * 0.9)
  );
  if (!provider_w || !provider_h || provider_w * provider_h < minPx) {
    console.warn("⚠️ provider image smaller than expected", {
      requested: { W, H },
      provider_w,
      provider_h,
      min_required: minPx,
    });
  }

  return { bytes, ctype: norm, provider_w, provider_h, url };
}

/* ------------------------ Supabase client ----------------------- */
function getSb() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) & SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function shortHash(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

/* ------------------------------ API ----------------------------- */
export default async function handler(req, res) {
  const t0 = Date.now();
  let tProv = 0,
    tUp = 0;

  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });

  if (req.method === "OPTIONS") return endStatus(res, 204);

  // Debug
  if (
    req.method === "GET" &&
    (req.query?.debug === "1" ||
      (typeof req.url === "string" && req.url.includes("debug=1")))
  ) {
    return sendJSON(res, 200, {
      ok: true,
      endpoint: "/api/v1/ideas/generate",
      has_supabase_url: Boolean(SUPABASE_URL),
      has_service_role: Boolean(SUPABASE_SERVICE_ROLE_KEY),
      bucket: BUCKET,
      output_public: OUTPUT_PUBLIC,
      max_dim: MAX_DIM,
      default_px: DEFAULT_PX,
      pollinations_timeout_ms: POL_TIMEOUT_MS,
      pollinations_enhance: POL_ENHANCE,
      pollinations_token_configured: Boolean(POL_TOKEN),
      now: new Date().toISOString(),
    });
  }

  if (req.method !== "POST") {
    return sendJSON(res, 405, {
      success: false,
      error: "method_not_allowed",
    });
  }

  // Body tolérant
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};

  const {
    slug,
    prompt,
    width,
    height,
    aspect_ratio,
    model = "flux",
    seed,
  } = body;

  if (!slug || !prompt) {
    return sendJSON(res, 400, {
      success: false,
      error: "missing_slug_or_prompt",
    });
  }

  let sb;
  try {
    sb = getSb();
  } catch (e) {
    return sendJSON(res, 500, {
      success: false,
      error: String(e?.message || e),
    });
  }

  // Dimensions HQ
  const { W, H } = computeDims({ width, height, aspect_ratio });

  // Idempotence : Idempotency-Key → nom de fichier stable
  const IDEM = (req.headers["idempotency-key"] || "").toString().slice(0, 160);
  const safeSlug = sanitize(slug);
  const folder = `categories/${safeSlug}`;

  // BaseId stable
  const baseId =
    IDEM ||
    `${safeSlug}-${shortHash(
      `${prompt}|${W}x${H}|${model}|${aspect_ratio || ""}`
    )}`;

  console.log(
    `🧾 request | ideas.generate HQ | slug=${safeSlug} | baseId=${baseId} | ${W}x${H}`
  );

  try {
    // 0) Bucket check (simple, pas d'idempotence storage pour rester rapide)
    const bucketCheck = await sb.storage.getBucket(BUCKET);
    if (!bucketCheck?.data) {
      return sendJSON(res, 500, {
        success: false,
        error: "bucket_not_found",
        bucket: BUCKET,
      });
    }

    // 1) Appel provider HQ
    const tP0 = Date.now();
    const { bytes, ctype, provider_w, provider_h } =
      await callPollinationsHQ({
        prompt,
        width: W,
        height: H,
        model,
        timeoutMs: POL_TIMEOUT_MS,
        seed,
      });
    tProv = Date.now() - tP0;
    console.log(
      "🧪 provider.call HQ | ok",
      provider_w,
      "x",
      provider_h,
      "| bytes=",
      bytes.length,
      "| ctype=",
      ctype
    );

    // 2) Déterminer extension
    const ext =
      ctype === "image/png"
        ? "png"
        : ctype === "image/webp"
        ? "webp"
        : ctype === "image/jpeg"
        ? "jpg"
        : "jpg";

    const keyPath = `${folder}/${baseId}.${ext}`;

    // 3) Upload Supabase
    const tU0 = Date.now();
    const up = await sb.storage.from(BUCKET).upload(keyPath, bytes, {
      contentType: ctype || "image/jpeg",
      upsert: true,
      cacheControl: CACHE_CONTROL,
    });
    tUp = Date.now() - tU0;

    if (up?.error) {
      return sendJSON(res, 500, {
        success: false,
        error: "upload_failed",
        details: String(up.error).slice(0, 200),
      });
    }

    // 4) URL publique / signée
    const imageUrl = OUTPUT_PUBLIC
      ? sb.storage.from(BUCKET).getPublicUrl(keyPath).data.publicUrl
      : (
          await sb.storage
            .from(BUCKET)
            .createSignedUrl(keyPath, SIGNED_TTL_S)
        ).data.signedUrl;

    console.log(`📦 stored HQ | ${imageUrl}`);

    const total = Date.now() - t0;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-processing-ms", String(total));
    res.setHeader(
      "server-timing",
      `provider;dur=${tProv}, upload;dur=${tUp}, total;dur=${total}`
    );

    return sendJSON(res, 200, {
      success: true,
      slug: safeSlug,
      image_url: imageUrl,
      bucket: BUCKET,
      key_path: keyPath,
      model_used: model,
      requested: {
        width: W,
        height: H,
        aspect_ratio: aspect_ratio || null,
      },
      provider_dims: { width: provider_w, height: provider_h },
      metrics: {
        total_ms: total,
        provider_ms: tProv,
        upload_ms: tUp,
        image_bytes: bytes.length,
        ctype,
      },
    });
  } catch (e) {
    console.error("❌ failed | ideas.generate HQ", e);
    return sendJSON(res, 500, {
      success: false,
      error: String(e).slice(0, 200),
    });
  }
}
