// /api/v1/ideas/generate.mjs — Production-ready (idempotence, retries, HQ defaults)
// Pollinations → Supabase Storage (public or signed), trace ideas_examples
// Storage layout configurable (no "ideas/" segment) + metrics (Server-Timing, x-processing-ms, JSON metrics)
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

/* ---------- ENV (server) ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Priorité: BUCKET_IDEAS > BUCKET_GALLERY > "ai_gallery"
const BUCKET = process.env.BUCKET_IDEAS || process.env.BUCKET_GALLERY || "ai_gallery";

// Visibilité unique : public (URL directe) ou privé (URL signée)
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC ?? "true") === "true";

// Provider
const POL_TOKEN = process.env.POLLINATIONS_TOKEN || "";
const POL_TIMEOUT_MS = Number(process.env.POLLINATIONS_TIMEOUT_MS || 60000);

// Storage
const SIGNED_TTL_S = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 30);
const CACHE_CONTROL = String(process.env.IDEAS_CACHE_CONTROL_S || 31536000);

// Layout configurable
const OUTPUTS_ROOT = process.env.OUTPUTS_ROOT || "outputs";
const PREVIEWS_ROOT = process.env.PREVIEWS_ROOT || "previews";
const ADD_DATE_SUBFOLDER = (process.env.ADD_DATE_SUBFOLDER ?? "true") === "true";

// Divers
const MAX_DIM = 1792;

/* ---------- Helpers ---------- */
const sanitize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);
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
  let W = clamp(width || 1536, 64, MAX_DIM);
  let H = clamp(height || 1536, 64, MAX_DIM);
  if (ar) {
    // si une seule dimension est fournie, calcule l'autre
    if (width && !height) H = clamp(Math.round((W * ar.h) / ar.w), 64, MAX_DIM);
    if (!width && height) W = clamp(Math.round((H * ar.w) / ar.h), 64, MAX_DIM);
    // si les deux existent, on garde (on suppose que Figma a déjà validé)
  }
  return { W, H };
}

async function fetchWithTimeout(url, init, ms) {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function callPollinations({ prompt, width = 1024, height = 1024, model = "flux", timeoutMs = POL_TIMEOUT_MS }) {
  const W = clamp(width, 64, MAX_DIM);
  const H = clamp(height, 64, MAX_DIM);

  const q = new URLSearchParams({
    model,
    width: String(W),
    height: String(H),
    private: "true",
    enhance: "true",
    nologo: "true",
  }).toString();

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`;
  const headers = {
    ...(POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {}),
    Accept: "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.8",
    "User-Agent": "Photoglow-API/ideas-generator",
  };

  // Petit retry (2 tentatives)
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetchWithTimeout(url, { headers }, timeoutMs);
      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(`pollinations_failed ${r.status} ${r.statusText} | ${msg.slice(0, 200)}`);
      }
      const ctype = (r.headers.get("content-type") || "").toLowerCase();
      if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype)) {
        const msg = await r.text().catch(() => "");
        throw new Error(`unexpected_content_type ${ctype || "(empty)"} | ${msg.slice(0, 200)}`);
      }
      const bytes = Buffer.from(await r.arrayBuffer());
      const norm =
        /image\/(jpeg|jpg)/i.test(ctype)
          ? "image/jpeg"
          : /image\/png/i.test(ctype)
          ? "image/png"
          : /image\/webp/i.test(ctype)
          ? "image/webp"
          : "application/octet-stream";
      return { bytes, ctype: norm };
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 400 * attempt));
    }
  }
  throw lastErr;
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
  // [METRICS] chronos
  const t0 = Date.now();
  let tIdem = 0, tProv = 0, tUp = 0;

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
      path_policy: {
        outputs_root: OUTPUTS_ROOT,
        previews_root: PREVIEWS_ROOT,
        add_date_subfolder: String(ADD_DATE_SUBFOLDER),
      },
      bucket_env_values: {
        BUCKET_IDEAS: process.env.BUCKET_IDEAS || null,
        BUCKET_GALLERY: process.env.BUCKET_GALLERY || null,
        BUCKET_IMAGES: process.env.BUCKET_IMAGES || null,
      },
      bucket_selected_precedence: "BUCKET_IDEAS > BUCKET_GALLERY > 'ai_gallery' (BUCKET_IMAGES ignored in this route)",
      pollinations_timeout_ms: POL_TIMEOUT_MS,
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "method_not_allowed" });
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

  const {
    slug,
    prompt,
    width,
    height,
    model = "flux",
    persist = false, // false => previews/, true => outputs/
    collection,

    // ---- champs catégories (facultatifs) ----
    category_id, // ex: "ai-headshots"
    prompt_index, // ex: 1, 2, 3...
    prompt_title, // ex: "Studio corporate"
    prompt_text, // ex: "professional corporate headshot..."
    aspect_ratio, // ex: "1:1" | "3:4" | ...
    style, // "cinematic" | "realistic" | ...
  } = body || {};

  if (!slug || !prompt) {
    return res.status(400).json({ success: false, error: "missing_slug_or_prompt" });
  }

  const sb = (() => {
    try {
      return getSb();
    } catch (e) {
      throw new Error(String(e?.message || e));
    }
  })();

  // Cible dimensions HQ (avec cohérence ratio si fourni)
  const { W, H } = fitByAspect({ width, height, aspect_ratio });

  // Idempotence — clé côté client (Figma)
  const IDEM = (req.headers["idempotency-key"] || "").toString().slice(0, 160);

  const safeSlug = sanitize(slug);
  const coll = collection ? sanitize(collection) : "";

  // --- Storage layout (configurable), plus de "ideas/"
  const root = persist ? OUTPUTS_ROOT : PREVIEWS_ROOT;
  const baseFolder = coll ? `${root}/${coll}` : root;
  const folder = `${baseFolder}/${safeSlug}${ADD_DATE_SUBFOLDER ? `/${today()}` : ""}`;

  // Nom de base déterministe : priorité à la clé client, sinon hash des paramètres
  const baseId =
    IDEM ||
    `${safeSlug}-${shortHash(
      `${category_id || ""}|${style || ""}|${prompt_title || ""}|${prompt_text || prompt}|${W}x${H}|${model}|${aspect_ratio || ""}|${coll}|${persist}`
    )}`;

  console.log(
    `🧾 request | ideas.generate | slug=${safeSlug} | bucket=${BUCKET} | persist=${persist} | baseId=${baseId} | ${W}x${H}`
  );

  try {
    // 0) Bucket check
    const bucketCheck = await sb.storage.getBucket(BUCKET);
    if (!bucketCheck?.data) {
      return res.status(500).json({ success: false, error: "bucket_not_found", bucket: BUCKET });
    }

    // 1) Idempotence côté storage : si persist + fichier déjà présent → retourne l'URL sans regénérer
    let existingExt = null;
    if (persist) {
      const tA = Date.now();
      const { data: list, error: listErr } = await sb.storage.from(BUCKET).list(folder, {
        search: baseId, // renvoie les fichiers qui contiennent baseId
        limit: 100,
      });
      tIdem += Date.now() - tA;

      if (!listErr && Array.isArray(list)) {
        const found = list.find(
          (f) => f.name === `${baseId}.jpg` || f.name === `${baseId}.png` || f.name === `${baseId}.webp`
        );
        if (found) {
          existingExt = found.name.split(".").pop();
          const keyPathExisting = `${folder}/${found.name}`;
          let imageUrl;
          if (OUTPUT_PUBLIC) {
            const { data } = sb.storage.from(BUCKET).getPublicUrl(keyPathExisting);
            imageUrl = data.publicUrl;
          } else {
            const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(keyPathExisting, SIGNED_TTL_S);
            if (error) throw error;
            imageUrl = data.signedUrl;
          }
          const total = Date.now() - t0;
          res.setHeader("server-timing", `idem;dur=${tIdem}, total;dur=${total}`);
          res.setHeader("x-processing-ms", String(total));
          return res.status(200).json({
            success: true,
            slug: safeSlug,
            image_url: imageUrl,
            bucket: BUCKET,
            persist,
            idempotent: true,
            category_id: category_id || null,
            style: style || null,
            metrics: { total_ms: total, idem_ms: tIdem, provider_ms: 0, upload_ms: 0, idempotent: true }
          });
        }
      }
    }

    // 2) Appel provider
    const tP0 = Date.now();
    const { bytes, ctype } = await callPollinations({ prompt, width: W, height: H, model });
    tProv += Date.now() - tP0;
    console.log("🧪 provider.call | ok");

    // 3) Nom final (extension réelle)
    const ext =
      ctype === "image/png" ? "png" : ctype === "image/webp" ? "webp" : ctype === "image/jpeg" ? "jpg" : "jpg";
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
      return res
        .status(500)
        .json({ success: false, error: "upload_failed", details: String(up.error).slice(0, 200) });
    }

    // 5) URL publique / signée (unique)
    let imageUrl;
    if (OUTPUT_PUBLIC) {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(keyPath);
      imageUrl = data.publicUrl;
    } else {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(keyPath, SIGNED_TTL_S);
      if (error)
        return res
          .status(500)
          .json({ success: false, error: "signed_url_failed", details: String(error).slice(0, 200) });
      imageUrl = data.signedUrl;
    }
    console.log(`📦 stored | ${imageUrl}`);

    // 6) Trace (non bloquant) — tentative enrichie (catégories) puis fallback minimal
    const traceEnriched = {
      slug: safeSlug,
      image_url: imageUrl,
      provider: "pollinations",
      bucket: BUCKET,
      key_path: keyPath,
      persist,
      // ---- champs catégories ----
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

    let traceError = null;
    try {
      const ins = await sb.from("ideas_examples").insert(traceEnriched);
      if (ins?.error) traceE
