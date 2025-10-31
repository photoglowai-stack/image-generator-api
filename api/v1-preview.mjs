// /api/v1-preview.mjs — Commercial Photoreal Preview (V6, perf & token-ready)
// - CORS inline, JSON only
// - Import Supabase dynamique: ../lib/supabase.mjs
// - GET: health & debug
// - Prompt compact photoréal (≤ ~180–200 chars), variations déterministes
// - Pollinations (model=flux): private=true, nologo=true, enhance=false, safe=true
// - Retry/backoff (429/502/503) + timeout aligné Vercel
// - Upload Supabase (public/signed), table preview_cache (insert/update non-bloquants)
// - Clé Storage COURTE & SAFE (hash hex), pas de base64 géant

export const config = { runtime: "nodejs" };

/* ---------- CORS ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ---------- ENV ---------- */
const POL_TOKEN       = process.env.POLLINATIONS_TOKEN || ""; // Bearer (optionnel mais recommandé)
const BUCKET          = process.env.PREVIEW_BUCKET || "generated_images";
const OUTPUT_PUBLIC   = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S    = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7);
const CACHE_CONTROL   = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);
const DEFAULT_SEED    = Number(process.env.PREVIEW_SEED || 777);
const PREVIEW_ENHANCE = (process.env.PREVIEW_ENHANCE ?? "false") === "true"; // OFF par défaut

// Budget temps Vercel (fail-fast < maxDuration)
const MAX_FUNCTION_S   = Number(process.env.MAX_FUNCTION_S || 25);
const SAFETY_MARGIN_S  = Number(process.env.SAFETY_MARGIN_S || 3);
const TIME_BUDGET_MS   = Math.max(5000, (MAX_FUNCTION_S - SAFETY_MARGIN_S) * 1000); // ~22s si 25s
const POLLINATIONS_TIMEOUT_MS = Math.max(4000, Math.min(TIME_BUDGET_MS - 1500, 18000));

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

// Fast plus petit ⇒ plus rapide (tu peux remonter à 640 si besoin)
const SIZE_HQ   = { "1:1": [896, 896], "3:4": [896, 1152] };
const SIZE_FAST = { "1:1": [576, 576], "3:4": [576, 768] };

const STYLE_VERSION = "commercial_photo_v2";

/* ---------- Normalisation form & seeds ---------- */
function normalizeForm(rawForm) {
  const form = rawForm && typeof rawForm === "object" ? rawForm : {};

  const gender = clamp(form.gender ?? form.sex, ["woman", "man"], 0);
  const background = clamp(form.background ?? form.bg ?? form.scene, BG, 0);
  const outfitKey = clamp(form.outfit ?? form.outfitKey ?? form.style, OUTFIT, 1);
  const ratio = clamp(form.aspect_ratio ?? form.aspectRatio ?? form.ratio, RATIO, 0);
  const skin = clamp(form.skin_tone ?? form.skinTone ?? form.skin, SKIN, 2);
  const hairLength = clamp(form.hair_length ?? form.hairLength ?? form.hairLen, HAIR_LEN, 2);
  const eyeColor = clamp(form.eye_color ?? form.eyeColor ?? form.eyes, EYE, 0);

  let hairColor = clamp(form.hair_color ?? form.hairColor ?? form.hair, HAIR_COLOR, 1);
  if (hairLength === "bald") hairColor = "none";

  const styleKey = `${background}|${outfitKey}|${skin}|${hairLength}|${hairColor}|${eyeColor}`;

  return {
    gender,
    background,
    outfitKey,
    ratio,
    skin,
    hairColor,
    hairLength,
    eyeColor,
    styleKey,
  };
}

function deriveSeed(userSeed, normalized, extra = "") {
  if (Number.isFinite(Number(userSeed))) return Math.floor(Number(userSeed));

  const baseHash = hash(`${STYLE_VERSION}|${normalized.styleKey}|${normalized.ratio}|${extra}`);
  const genderOffset = normalized.gender === "woman" ? 0 : 7919;
  const derived = (baseHash + genderOffset) >>> 0;
  return derived || DEFAULT_SEED;
}

/* ---------- Deterministic variations & hashing ---------- */
const hash = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24)) >>> 0; }
  return h >>> 0;
};
const pick = (arr, h) => arr[h % arr.length];

/* ---------- Prompt Builder (compact & photoreal) ---------- */
function buildPrompt(normalized) {
  const BG_MAP = {
    studio: "white studio background",
    office: "modern office background",
    city: "city skyline background",
    nature: "outdoor nature background",
  };
  const OUTFIT_W = {
    blazer: "tailored blazer",
    shirt: "fitted blouse",
    tee: "crew-neck tee",
    athleisure: "athleisure top",
  };
  const OUTFIT_M = {
    blazer: "tailored blazer",
    shirt: "fitted shirt",
    tee: "crew-neck tee",
    athleisure: "athletic performance tee",
  };
  const SKIN_MAP = {
    light: "light skin tone",
    fair: "fair skin tone",
    medium: "medium skin tone",
    tan: "tan skin tone",
    deep: "deep skin tone",
  };
  const EYE_MAP = {
    brown: "brown eyes",
    blue: "blue eyes",
    green: "green eyes",
    hazel: "hazel eyes",
    gray: "gray eyes",
  };

  const FRAMING = ["portrait", "close-up portrait", "headshot"];
  const LENSES = ["85mm f/1.8", "50mm f/1.4", "135mm f/2"];
  const LIGHTS = ["soft beauty lighting", "natural window light", "studio lighting"];

  const { gender, background, outfitKey, skin, hairColor, hairLength, eyeColor, styleKey } = normalized;

  const styleSeed = hash(`${STYLE_VERSION}|${styleKey}`);
  normalized.framing = pick(FRAMING, styleSeed);
  normalized.lens = pick(LENSES, styleSeed >> 4);
  normalized.lighting = pick(LIGHTS, styleSeed >> 8);

  const outfit = (gender === "woman" ? OUTFIT_W : OUTFIT_M)[outfitKey];
  const hairPhrase = hairLength === "bald" ? "clean-shaven head" : `${hairLength} ${hairColor} hair`;

  const subject = gender === "woman" ? "confident professional woman" : "confident professional man";
  const grooming = gender === "woman" ? "refined natural makeup" : "well-groomed facial features";

  const parts = [
    `professional ${normalized.framing} of a ${subject}`,
    BG_MAP[background],
    outfit,
    hairPhrase,
    SKIN_MAP[skin],
    EYE_MAP[eyeColor],
    normalized.lens,
    normalized.lighting,
    grooming,
    "photorealistic commercial portrait",
  ];

  const uniqueParts = parts.filter(Boolean);
  let prompt = uniqueParts.join(", ");
  if (prompt.length > 200) {
    prompt = uniqueParts.filter((p) => p !== grooming).join(", ");
  }
  if (prompt.length > 200) {
    prompt = uniqueParts.filter((p) => p !== normalized.lens).join(", ");
  }
  return prompt;
}

/* ---------- Pollinations fetch (POST prioritaire, fallback GET) ---------- */
const POLLINATIONS_ENDPOINT = "https://image.pollinations.ai/prompt";

async function fetchWithTimeout(url, init = {}, timeoutMs = POLLINATIONS_TIMEOUT_MS) {
  if (timeoutMs <= 0) throw new Error("invalid_timeout");
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readImageResponse(res) {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`pollinations_http_${res.status}_${txt.slice(0,160)}`);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  const ab = await res.arrayBuffer();
  const bytes = Buffer.from(ab);
  if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype) && bytes.length < 64 * 1024) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 160));
    throw new Error(`pollinations_unexpected_payload_${ctype || "unknown"}_${preview}`);
  }
  return { bytes, ctype: ctype || "image/jpeg" };
}

async function fetchPollinationsBinary({ prompt, width, height, seed, safe }) {
  const baseHeaders = {
    Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.8",
    "User-Agent": "Photoglow-Preview/1.0",
  };
  if (POL_TOKEN) baseHeaders.Authorization = `Bearer ${POL_TOKEN}`;

  const body = JSON.stringify({
    prompt,
    width,
    height,
    seed,
    model: "flux",
    private: true,
    nologo: true,
    enhance: PREVIEW_ENHANCE,
    safe: safe === "true",
  });

  try {
    const res = await fetchWithTimeout(POLLINATIONS_ENDPOINT, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body,
    });
    return await readImageResponse(res);
  } catch (err) {
    console.warn("[preview] pollinations POST failed:", err?.message || err);
  }

  const params = new URLSearchParams({
    model: "flux",
    width: String(width),
    height: String(height),
    seed: String(seed),
    private: "true",
    nologo: "true",
    enhance: PREVIEW_ENHANCE ? "true" : "false",
    safe,
  });
  const url = `${POLLINATIONS_ENDPOINT}/${encodeURIComponent(prompt)}?${params.toString()}`;
  const res = await fetchWithTimeout(url, { method: "GET", headers: baseHeaders });
  return await readImageResponse(res);
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

  // Import dynamique Supabase (chemin correct)
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

    const normalized = normalizeForm(form);
    if (!ok(form?.prompt)) form.prompt = buildPrompt(normalized);

    // Render settings
    const fast  = toBool(form?.fast ?? true); // fast par défaut
    const ratio = normalized.ratio;
    const [W,H] = (fast ? SIZE_FAST : SIZE_HQ)[ratio] || (fast ? [576,576] : [896,896]);
    const seed  = deriveSeed(form?.seed, normalized, `${normalized.framing}|${normalized.lighting}|${normalized.lens}`);
    const safe  = toBool(form?.safe ?? true) ? "true" : "false"; // ON par défaut
    const prompt= String(form.prompt);

    // Cache key (long) — uniquement pour la BDD
    const cacheKey = `${STYLE_VERSION}${fast ? "|fast" : ""}|${prompt}|seed:${seed}|${W}x${H}`;

    // Cache lookup (non bloquant si update)
    const cached = await sb.from("preview_cache").select("image_url,hits").eq("key", cacheKey).maybeSingle();
    if (cached.data?.image_url) {
      try {
        const upd = await sb.from("preview_cache").update({ hits: (cached.data.hits || 0) + 1 }).eq("key", cacheKey);
        if (upd.error) console.warn("[cache.update] non-blocking error:", upd.error);
      } catch (e) {
        console.warn("[cache.update] non-blocking exception:", e);
      }
      return res.status(200).json({ ok:true, image_url: cached.data.image_url, provider:"cache", seed, key: cacheKey, fast: !!fast });
    }

    // Pollinations call (1 essai, timeout budgeté)
    let result;
    try {
      result = await fetchPollinationsBinary({ prompt, width: W, height: H, seed, safe });
    } catch (err) {
      return res.status(502).json({ ok:false, error:"pollinations_failed", details:String(err).slice(0,200) });
    }
    const { bytes, ctype } = result;

    // Supabase upload — clé COURTE & SAFE : v2[-fast]-s{seed}-{W}x{H}-{hash}.jpg
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth()+1).padStart(2,'0');
    const dd   = String(d.getUTCDate()).padStart(2,'0');

    const hval   = hash(cacheKey + (POL_TOKEN ? "|auth" : "|noauth"));
    const suffix = hval.toString(16).padStart(8,"0");
    const ext    = ctype.includes("png") ? "png" : ctype.includes("webp") ? "webp" : "jpg";
    const uploadContentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const fileKey = `${STYLE_VERSION}${fast?'-fast':''}-s${seed}-${W}x${H}-${suffix}.${ext}`;
    const path = `previews/${yyyy}-${mm}-${dd}/${fileKey}`;

    const up = await sb.storage.from(BUCKET).upload(path, bytes, {
      contentType: uploadContentType,
      upsert: true,
      cacheControl: CACHE_CONTROL
    });
    if (up.error) return res.status(500).json({ ok:false, error:"upload_failed", details:String(up.error).slice(0,200) });

    let imageUrl;
    if (OUTPUT_PUBLIC) {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      imageUrl = data.publicUrl;
    } else {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_S);
      if (error) return res.status(500).json({ ok:false, error:"signed_url_failed", details:String(error).slice(0,200) });
      imageUrl = data.signedUrl;
    }

    // Insert cache (best-effort, no crash)
    try {
      const ins = await sb.from("preview_cache").insert({ key: cacheKey, image_url: imageUrl });
      if (ins.error) console.warn("[cache.insert] non-blocking error:", ins.error);
    } catch (e) {
      console.warn("[cache.insert] non-blocking exception:", e);
    }

    return res.status(200).json({ ok:true, image_url: imageUrl, provider:"pollinations", seed, key: cacheKey, fast: !!fast });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"server_error", details:String(e).slice(0,400) });
  }
}
