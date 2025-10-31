// /api/v1-preview.mjs — Commercial Photoreal Preview (V5, stable)
// 🧯 CORS inline, réponses JSON
// 🔐 Import Supabase dynamique (cold-start safe) — chemin corrigé ../lib/supabase.mjs
// ✅ GET health & debug
// ✅ Prompt compact photoréal (≤ ~180–200 chars), variations déterministes
// ✅ Pollinations: model=flux, private=true, nologo=true, enhance=false (par défaut), safe=true
// ✅ Retry/backoff (429/502/503) + timeout
// ✅ Upload Supabase (public ou signed), cache table preview_cache

export const config = { runtime: "nodejs" };

/* ---------- CORS ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*"); // Figma (Origin: null) OK
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ---------- ENV ---------- */
const POL_TOKEN       = process.env.POLLINATIONS_TOKEN || ""; // Bearer côté serveur (optionnel mais recommandé)
const BUCKET          = process.env.PREVIEW_BUCKET || "generated_images";
const OUTPUT_PUBLIC   = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S    = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7);
const CACHE_CONTROL   = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);
const DEFAULT_SEED    = Number(process.env.PREVIEW_SEED || 777);
const PREVIEW_ENHANCE = (process.env.PREVIEW_ENHANCE ?? "false") === "true"; // OFF par défaut pour éviter le look stylisé
const MEMORY_CACHE_TTL_MS = Number(process.env.PREVIEW_MEMORY_CACHE_TTL_MS || 2 * 60 * 1000); // 2 minutes par défaut
const MEMORY_CACHE_MAX = Number(process.env.PREVIEW_MEMORY_CACHE_MAX || 32);

const memoryCache = new Map();
const inflightRenders = new Map();

function trimCacheIfNeeded() {
  if (!Number.isFinite(MEMORY_CACHE_MAX) || MEMORY_CACHE_MAX <= 0) return;
  while (memoryCache.size > MEMORY_CACHE_MAX) {
    const oldestKey = memoryCache.keys().next().value;
    if (!oldestKey) break;
    memoryCache.delete(oldestKey);
  }
}

function setMemoryCache(key, payload) {
  if (!Number.isFinite(MEMORY_CACHE_TTL_MS) || MEMORY_CACHE_TTL_MS <= 0) return;
  memoryCache.set(key, { payload, expires: Date.now() + MEMORY_CACHE_TTL_MS });
  trimCacheIfNeeded();
}

function getMemoryCache(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.payload;
}

/* ---------- Helpers ---------- */
const ok    = (v) => typeof v === "string" && v.trim().length > 0;
const clamp = (v, arr, d = 0) => (ok(v) && arr.includes(v) ? v : arr[d]);
const toBool= (v) => v === true || v === "true" || v === "1" || v === 1;

const BG         = ["studio","office","city","nature"];
const OUTFIT     = ["blazer","shirt","tee","athleisure"];
const RATIO      = ["1:1","3:4"];
const SKIN       = ["light","fair","medium","tan","deep"];
const HAIR_COLOR = ["black","brown","blonde","red","gray"];
const HAIR_LEN   = ["short","medium","long","bald"];
const EYE        = ["brown","blue","green","hazel","gray"];

const SIZE_HQ   = { "1:1": [896, 896], "3:4": [896, 1152] };
const SIZE_FAST = { "1:1": [640, 640], "3:4": [672, 896] };

const STYLE_VERSION = "commercial_photo_v2";

/* ---------- Deterministic variations ---------- */
const hash = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24)) >>> 0; }
  return h >>> 0;
};
const pick = (arr, h) => arr[h % arr.length];

/* ---------- Prompt Builder (compact & photoreal) ---------- */
function buildPrompt(form) {
  const gender    = clamp(form?.gender, ["woman","man"], 0);
  const bgKey     = clamp(form?.background, BG, 0);
  const outfitKey = clamp(form?.outfit, OUTFIT, 1);
  const skin      = clamp(form?.skin_tone ?? form?.skinTone ?? form?.skin, SKIN, 2);
  const hairC     = clamp(form?.hair_color ?? form?.hairColor ?? form?.hair, HAIR_COLOR, 1);
  const hairL     = clamp(form?.hair_length ?? form?.hairLength ?? form?.hairLen, HAIR_LEN, 2);
  const eyes      = clamp(form?.eye_color ?? form?.eyeColor ?? form?.eyes, EYE, 0);

  const BG_MAP   = { studio:"white studio background", office:"office background", city:"city background", nature:"nature background" };
  const OUTFIT_W = { blazer:"tailored blazer", shirt:"fitted top",  tee:"crew-neck tee", athleisure:"athleisure top" };
  const OUTFIT_M = { blazer:"tailored blazer", shirt:"fitted shirt", tee:"crew-neck tee", athleisure:"athletic tee" };

  const outfit     = gender === "woman" ? OUTFIT_W[outfitKey] : OUTFIT_M[outfitKey];
  const hairPhrase = hairL === "bald" ? "bald" : `${hairL} ${hairC} hair`;

  const FRAMING = ["portrait","close-up portrait","headshot"];
  const LENSES  = ["85mm f/1.8","50mm f/1.4","135mm f/2"];
  const LIGHTS  = ["soft beauty lighting","natural window light","studio lighting"];

  const seedStr = String(form?.seed ?? `${gender}|${bgKey}|${outfitKey}|${skin}|${hairC}|${hairL}|${eyes}`);
  const h = hash(seedStr);
  const framing  = pick(FRAMING, h);
  const lens     = pick(LENSES,  h >> 4);
  const lighting = pick(LIGHTS,  h >> 8);

  const parts = [
    `professional ${framing} of ${gender === "woman" ? "woman" : "man"}`,
    BG_MAP[bgKey], outfit, hairPhrase, `${skin} skin`, `${eyes} eyes`,
    lens, lighting,
    gender === "woman" ? "natural makeup" : "neat grooming",
    "photorealistic", "commercial"
  ];

  let prompt = parts.join(", ");
  if (prompt.length > 200) prompt = parts.filter(p => !["natural makeup","neat grooming"].includes(p)).join(", ");
  if (prompt.length > 200) prompt = parts.filter(p => p !== lens).join(", ");
  return prompt;
}

/* ---------- Pollinations fetch with retry/backoff ---------- */
async function fetchPollinations(url, headers, tries = 3, baseDelayMs = 600, timeoutMs = 45000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      let r;
      if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
        r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } else {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
        try { r = await fetch(url, { headers, signal: ac.signal }); }
        finally { clearTimeout(t); }
      }
      if (r.ok) return r;
      // Retry uniquement sur 429/502/503
      if (![429,502,503].includes(r.status)) {
        const txt = await r.text().catch(()=> "");
        throw new Error(`HTTP ${r.status} ${txt.slice(0,200)}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise(s => setTimeout(s, baseDelayMs * (2 ** i))); // 600ms, 1200ms, 2400ms
  }
  throw new Error(`pollinations_failed_after_retries: ${String(lastErr || "unknown")}`);
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  setCORS(req, res);
  res.setHeader("content-type", "application/json");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Health & debug
  if (req.method === "GET") {
    const hasUrl  = Boolean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
    const hasSrv  = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const dbg     = (req.query && (req.query.debug === "1" || req.query.debug === 1));
    return res.status(200).json(dbg
      ? { ok:true, endpoint:"/v1/preview", has_supabase_url:hasUrl, has_service_role:hasSrv, bucket:BUCKET, output_public:OUTPUT_PUBLIC }
      : { ok:true, ready:true, endpoint:"/v1/preview" }
    );
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  // Import dynamique Supabase (chemin corrigé)
  let ensureSupabaseClient, getSupabaseServiceRole, sb;
  try {
    ({ ensureSupabaseClient, getSupabaseServiceRole } = await import("../lib/supabase.mjs"));
  } catch (e) {
    return res.status(500).json({ ok:false, error:"supabase_module_load_failed", details:String(e).slice(0,200) });
  }

  try {
    try { sb = getSupabaseServiceRole(); }
    catch { return res.status(500).json({ ok:false, error:"missing_env_supabase" }); }
    ensureSupabaseClient(sb, "service");

    // Parse body tolérant
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const form = (body && typeof body === "object") ? body : {};
    if (!ok(form?.prompt)) form.prompt = buildPrompt(form);

    // Render settings
    const fast  = toBool(form?.fast);
    const ratio = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO, 0);
    const [W,H] = (fast ? SIZE_FAST : SIZE_HQ)[ratio] || (fast ? [640,640] : [896,896]);
    const seed  = Number.isFinite(Number(form?.seed)) ? Math.floor(Number(form.seed)) : DEFAULT_SEED;
    const safe  = (form?.safe ?? true) ? "true" : "false"; // OFF → à tes risques; ON par défaut pour la preview
    const prompt= String(form.prompt);

    // Cache key
    const key = `${STYLE_VERSION}${fast ? "|fast" : ""}|${prompt}|seed:${seed}|${W}x${H}`;
    const safeKey = Buffer.from(key).toString("base64url").slice(0, 120);

    const mem = getMemoryCache(key);
    if (mem) {
      return res.status(200).json({ ...mem, cache_level: "memory" });
    }

    // Cache lookup
    const cached = await sb.from("preview_cache").select("image_url,hits").eq("key", key).maybeSingle();
    if (cached.data?.image_url) {
      try { await sb.from("preview_cache").update({ hits:(cached.data.hits||0)+1 }).eq("key", key); } catch {}
      const payload = { ok:true, image_url: cached.data.image_url, provider:"cache", seed, key, fast: !!fast };
      setMemoryCache(key, payload);
      return res.status(200).json(payload);
    }

    const pending = inflightRenders.get(key);
    if (pending) {
      const payload = await pending;
      return res.status(200).json({ ...payload, cache_level: payload.cache_level || "dedup" });
    }

    const renderPromise = (async () => {
      // Pollinations call (GET image bytes)
      const params = new URLSearchParams({
        model: "flux",
        width: String(W),
        height: String(H),
        seed: String(seed),
        private: "true",
        nologo: "true",
        enhance: PREVIEW_ENHANCE ? "true" : "false",
        safe
      }).toString();
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
      const headers = POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {};

      const r = await fetchPollinations(url, headers, /*tries*/ 3, /*baseDelay*/ 600, /*timeout*/ fast ? 25000 : 60000);
      const arrayBuffer = await r.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);

      const rawContentType = r.headers?.get?.("content-type") || "";
      const normalized = rawContentType.split(";")[0].trim().toLowerCase();
      let uploadContentType = "image/jpeg";
      let extension = "jpg";
      if (normalized.includes("png")) {
        uploadContentType = "image/png";
        extension = "png";
      } else if (normalized.includes("webp")) {
        uploadContentType = "image/webp";
        extension = "webp";
      } else if (normalized.includes("jpeg") || normalized.includes("jpg")) {
        uploadContentType = "image/jpeg";
        extension = "jpg";
      } else if (normalized) {
        uploadContentType = normalized;
        const guessed = normalized.split("/")[1];
        if (guessed) extension = guessed.replace(/[^a-z0-9]/g, "") || "jpg";
      }

      const d = new Date();
      const yyyy = d.getUTCFullYear();
      const mm   = String(d.getUTCMonth()+1).padStart(2,'0');
      const dd   = String(d.getUTCDate()).padStart(2,'0');
      const path = `previews/${yyyy}-${mm}-${dd}/${safeKey}.${extension}`;

      const up = await sb.storage.from(BUCKET).upload(path, bytes, {
        contentType: uploadContentType,
        upsert: true,
        cacheControl: CACHE_CONTROL
      });
      if (up.error) {
        throw Object.assign(new Error("upload_failed"), { cause: up.error });
      }

      let imageUrl;
      if (OUTPUT_PUBLIC) {
        const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
        imageUrl = data.publicUrl;
      } else {
        const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_S);
        if (error) {
          throw Object.assign(new Error("signed_url_failed"), { cause: error });
        }
        imageUrl = data.signedUrl;
      }

      try {
        await sb.from("preview_cache").insert({ key, image_url: imageUrl });
      } catch (err) {
        console.warn("preview_cache_insert_failed", err?.message || err);
      }

      const payload = {
        ok: true,
        image_url: imageUrl,
        provider: "pollinations",
        seed,
        key,
        fast: !!fast,
        width: W,
        height: H,
        content_type: uploadContentType,
      };
      setMemoryCache(key, payload);
      return payload;
    })();

    inflightRenders.set(key, renderPromise);
    try {
      const payload = await renderPromise;
      return res.status(200).json(payload);
    } finally {
      inflightRenders.delete(key);
    }
  } catch (e) {
    if (e?.message === "upload_failed" && e?.cause) {
      const cause = e.cause;
      const detail = cause?.message || cause?.error || cause?.name || JSON.stringify(cause);
      return res.status(500).json({ ok:false, error:"upload_failed", details:String(detail).slice(0,200) });
    }
    if (e?.message === "signed_url_failed" && e?.cause) {
      const cause = e.cause;
      const detail = cause?.message || cause?.error || cause?.name || JSON.stringify(cause);
      return res.status(500).json({ ok:false, error:"signed_url_failed", details:String(detail).slice(0,200) });
    }
    return res.status(500).json({ ok:false, error:"server_error", details:String(e).slice(0,400) });
  }
}
