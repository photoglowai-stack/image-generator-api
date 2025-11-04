// /api/v1-preview.mjs — V9 Preview-by-default (no storage unless save:true)
// - Preview: JSON provider_url (aucun upload)
// - proxy:true: renvoie le binaire image/jpeg (Figma-friendly), transcode si besoin
// - save:true: télécharge -> upload Supabase -> renvoie image_url (outputs/YYYY-MM-DD/...jpg)
// - Flags: strict, safe, proxy, save, debug_compare (uniquement avec save:true)

const RATE_WINDOW_MS = 10_000; // 10s
const RATE_MAX = 10;           // 10 req / 10s / IP
const _seen = new Map();

function rateLimit(req) {
  const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || "anon").trim();
  const now = Date.now();
  const arr = (_seen.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  _seen.set(ip, arr);
  if (arr.length > RATE_MAX) {
    const err = new Error("rate_limited");
    err.status = 429;
    throw err;
  }
}
function idemKey(req) { return String(req.headers["idempotency-key"] || ""); }
globalThis.__idemCache ||= new Map();

export const config = { runtime: "nodejs", maxDuration: 25 };

/* ----------------------------- CORS ----------------------------- */
function setCORS(req, res) {
  const origin = req.headers.origin;
  const allow = (!origin || origin === "null") ? "null" : origin;
  res.setHeader("access-control-allow-origin", allow);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ------------------------------ ENV ----------------------------- */
const POL_TOKEN       = process.env.POLLINATIONS_TOKEN || "";
const BUCKET          = process.env.PREVIEW_BUCKET || "generated_images";
const OUTPUT_PUBLIC   = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S    = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7);
const CACHE_CONTROL   = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);
const DEFAULT_SEED    = Number(process.env.PREVIEW_SEED || 777);
const PREVIEW_ENHANCE = (process.env.PREVIEW_ENHANCE ?? "false") === "true";

const MAX_FUNCTION_S   = Number(process.env.MAX_FUNCTION_S || 25);
const SAFETY_MARGIN_S  = Number(process.env.SAFETY_MARGIN_S || 3);
const TIME_BUDGET_MS   = Math.max(5000, (MAX_FUNCTION_S - SAFETY_MARGIN_S) * 1000);
const POL_TIMEOUT_MS   = Math.max(4000, Math.min(TIME_BUDGET_MS - 1500, 18000));

/* ---------------------------- Helpers --------------------------- */
const ok     = (v) => typeof v === "string" && v.trim().length > 0;
const toBool = (v) => v === true || v === "true" || v === "1" || v === 1;
const clamp  = (v, arr, d = 0) => (ok(v) && arr.includes(v) ? v : arr[d]);

const BG         = ["studio","office","city","nature"];
const OUTFIT     = ["blazer","shirt","tee","athleisure"];
const RATIO      = ["1:1","3:4"];
const SKIN       = ["light","fair","medium","tan","deep"];
const HAIR_COLOR = ["black","brown","blonde","red","gray"];
const HAIR_LEN   = ["short","medium","long","bald"];
const EYE        = ["brown","blue","green","hazel","gray"];

const SIZE_HQ   = { "1:1": [896, 896], "3:4": [896, 1152] };
const SIZE_FAST = { "1:1": [576, 576], "3:4": [576, 768] };
const STYLE_VERSION = "commercial_photo_v2";

const hash = (s) => { let h = 2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h+(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))>>>0 } return h>>>0; };
const pick = (arr, h) => arr[h % arr.length];

/* -------------------- Normalisation + seed ---------------------- */
function normalizeForm(raw) {
  const form = raw && typeof raw === "object" ? raw : {};
  const gender     = clamp(form.gender ?? form.sex, ["woman","man"], 1);
  const background = clamp(form.background ?? form.bg ?? form.scene, BG, 0);
  const outfitKey  = clamp(form.outfit ?? form.outfitKey ?? form.style, OUTFIT, 2);
  const ratio      = clamp(form.aspect_ratio ?? form.aspectRatio ?? form.ratio, RATIO, 1);
  const skin       = clamp(form.skin_tone ?? form.skinTone ?? form.skin, SKIN, 2);
  const hairLength = clamp(form.hair_length ?? form.hairLength ?? form.hairLen, HAIR_LEN, 0);
  const eyeColor   = clamp(form.eye_color ?? form.eyeColor ?? form.eyes, EYE, 0);

  let hairColor    = clamp(form.hair_color ?? form.hairColor ?? form.hair, HAIR_COLOR, 1);
  if (hairLength === "bald") hairColor = "none";

  const styleKey   = `${background}|${outfitKey}|${skin}|${hairLength}|${hairColor}|${eyeColor}`;
  return { gender, background, outfitKey, ratio, skin, hairColor, hairLength, eyeColor, styleKey };
}

function deriveSeed(userSeed, n, extra = "") {
  if (Number.isFinite(Number(userSeed))) return Math.floor(Number(userSeed));
  const base = hash(`${STYLE_VERSION}|${n.styleKey}|${n.ratio}|${extra}`);
  const offset = n.gender === "woman" ? 0 : 7919;
  const derived = (base + offset) >>> 0;
  return derived || DEFAULT_SEED;
}

/* ------------------------ Prompt builder ------------------------ */
function buildPrompt(n) {
  const BG_MAP = { studio:"white studio background", office:"modern office background", city:"city skyline background", nature:"outdoor nature background" };
  const OUTFIT_W = { blazer:"tailored blazer", shirt:"fitted blouse", tee:"crew-neck tee", athleisure:"athleisure top" };
  const OUTFIT_M = { blazer:"tailored blazer", shirt:"fitted shirt",  tee:"crew-neck tee", athleisure:"athletic performance tee" };
  const SKIN_MAP = { light:"light skin tone", fair:"fair skin tone", medium:"medium skin tone", tan:"tan skin tone", deep:"deep skin tone" };
  const EYE_MAP  = { brown:"brown eyes", blue:"blue eyes", green:"green eyes", hazel:"hazel eyes", gray:"gray eyes" };
  const FRAMING = ["portrait","close-up portrait","headshot"];
  const LENSES  = ["85mm f/1.8","50mm f/1.4","135mm f/2"];
  const LIGHTS  = ["soft beauty lighting","natural window light","studio lighting"];

  const seed = hash(`${STYLE_VERSION}|${n.styleKey}`);
  n.framing  = pick(FRAMING, seed);
  n.lens     = pick(LENSES,  seed>>4);
  n.lighting = pick(LIGHTS,  seed>>8);

  const outfit = (n.gender === "woman" ? OUTFIT_W : OUTFIT_M)[n.outfitKey];
  const hairPhrase = n.hairLength === "bald" ? "clean-shaven head" : `${n.hairLength} ${n.hairColor} hair`;
  const subject = n.gender === "woman" ? "confident professional woman" : "confident professional man";
  const grooming = n.gender === "woman" ? "refined natural makeup" : "well-groomed facial features";

  const parts = [
    `professional ${n.framing} of a ${subject}`,
    BG_MAP[n.background], outfit, hairPhrase,
    SKIN_MAP[n.skin], EYE_MAP[n.eyeColor],
    n.lens, n.lighting, grooming,
    "photorealistic commercial portrait",
  ].filter(Boolean);

  let prompt = parts.join(", ");
  if (prompt.length > 200) prompt = parts.filter(p => p !== grooming).join(", ");
  if (prompt.length > 200) prompt = parts.filter(p => p !== n.lens).join(", ");
  return prompt;
}

/* --------------------- Pollinations (HTTP) ---------------------- */
const POL_ENDPOINT = "https://image.pollinations.ai/prompt";

async function fetchWithTimeout(url, init = {}, timeoutMs = POL_TIMEOUT_MS) {
  if (timeoutMs <= 0) throw new Error("invalid_timeout");
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function readImageResponse(res) {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`pollinations_http_${res.status}_${txt.slice(0,160)}`);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  const ab = await res.arrayBuffer();
  const bytes = Buffer.from(ab);
  if (!/^image\//.test(ctype) || bytes.length < 24 * 1024) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 160));
    throw new Error(`pollinations_unexpected_${ctype || "unknown"}_len${bytes.length}_${preview}`);
  }
  return { bytes, ctype: ctype.includes("png") ? "image/png" : ctype.includes("webp") ? "image/webp" : "image/jpeg" };
}

function buildProviderURL({ prompt, width, height, seed, safe }) {
  const qs = new URLSearchParams({
    model:"flux",
    width:String(width),
    height:String(height),
    seed:String(seed),
    private:"true",
    nologo:"true",
    enhance: PREVIEW_ENHANCE ? "true" : "false",
    safe
  }).toString();
  return `${POL_ENDPOINT}/${encodeURIComponent(prompt)}?${qs}`;
}

async function fetchPollinationsBinary({ prompt, width, height, seed, safe }) {
  const baseHeaders = { Accept: "image/*", "User-Agent": "Photoglow-Preview/1.0" };
  if (POL_TOKEN) baseHeaders.Authorization = `Bearer ${POL_TOKEN}`;

  const url = buildProviderURL({ prompt, width, height, seed, safe });
  let lastErr;
  for (let i=0;i<=2;i++){
    try {
      const res = await fetchWithTimeout(url, { method:"GET", headers: baseHeaders });
      return await readImageResponse(res);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error("pollinations_failed");
}

/* --------------------- Transcodage → JPEG ----------------------- */
async function toJPEG(bytes) {
  try {
    const sharpMod = await import('sharp');
    const sharp = (sharpMod.default || sharpMod);
    return await sharp(Buffer.from(bytes)).jpeg({ quality: 92 }).toBuffer();
  } catch {
    // Fallback: bytes bruts si sharp indisponible (déconseillé pour Figma si WEBP)
    return Buffer.from(bytes);
  }
}

/* ------------------------------ API ----------------------------- */
export default async function handler(req, res) {
  setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    const hasUrl = Boolean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
    const hasSrv = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    return res.status(200).json({
      ok:true, endpoint:"/v1/preview",
      has_supabase_url:hasUrl, has_service_role:hasSrv,
      bucket:BUCKET, output_public:OUTPUT_PUBLIC, poll_token:Boolean(POL_TOKEN)
    });
  }

  if (req.method !== "POST") {
    res.setHeader("content-type","application/json");
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  // Parse body
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== "object") body = {};

  const reqId = (await import("node:crypto")).randomUUID();
  try {
    rateLimit(req);
  } catch (e) {
    res.setHeader("content-type", "application/json");
    console.log(JSON.stringify({ level:"warn", reqId, event:"rate_limited" }));
    return res.status(e.status || 429).json({ ok:false, error:"rate_limited" });
  }
  const idem = idemKey(req);

  const strict = toBool(body?.strict);
  const proxy  = toBool(body?.proxy);   // binaire
  const save   = toBool(body?.save);    // upload Supabase

  console.log(JSON.stringify({ level:"info", reqId, event:"preview_start", flags:{ strict, proxy, save } }));

  if (idem && globalThis.__idemCache.has(idem)) {
    const cached = globalThis.__idemCache.get(idem);
    res.setHeader("content-type","application/json");
    console.log(JSON.stringify({ level:"info", reqId, event:"idem_hit" }));
    return res.status(200).json(cached);
  }

  // Normalisation & prompt
  const n = normalizeForm(body);
  const fastDefault = !strict; // strict => on respecte width/height fournis
  const fast = toBool(body?.fast ?? fastDefault);

  // Dimensions
  let [W,H] = (fast ? SIZE_FAST : SIZE_HQ)[n.ratio] || (fast ? [576,576] : [896,896]);
  if (strict) {
    const bw = Number(body.width), bh = Number(body.height);
    if (Number.isFinite(bw) && Number.isFinite(bh) && bw >= 64 && bh >= 64) {
      W = Math.floor(bw); H = Math.floor(bh);
    }
  }

  // Prompt & seed
  const prompt = strict && ok(body.prompt) ? String(body.prompt) : (ok(body?.prompt) ? String(body.prompt) : buildPrompt(n));
  const seed   = strict && Number.isFinite(Number(body?.seed))
    ? Math.floor(Number(body.seed))
    : deriveSeed(body?.seed, n, `${n.framing}|${n.lighting}|${n.lens}`);
  const safe   = toBool(body?.safe ?? true) ? "true" : "false";

  /* --------------------- PREVIEW (JSON) ---------------------- */
  if (!save && !proxy) {
    const provider_url = buildProviderURL({ prompt, width: W, height: H, seed, safe });
    res.setHeader("content-type","application/json");
    return res.status(200).json({ ok:true, mode:"preview", provider_url, width:W, height:H, fast:!!fast });
  }

  /* --------------------- PROXY (BINAIRE) --------------------- */
  if (!save && proxy) {
    try {
      const { bytes, ctype } = await fetchPollinationsBinary({ prompt, width: W, height: H, seed, safe });
      const out = ctype.includes("jpeg") ? bytes : await toJPEG(bytes);
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-disposition", 'inline; filename="preview.jpg"');
      return res.status(200).send(out);
    } catch (e) {
      res.setHeader("content-type","application/json");
      return res.status(502).json({ ok:false, mode:"proxy", error:"pollinations_failed", details:String(e).slice(0,200) });
    }
  }

  /* ----------------------- SAVE (UPLOAD) --------------------- */
  let bin;
  try {
    bin = await fetchPollinationsBinary({ prompt, width: W, height: H, seed, safe });
  } catch (e) {
    res.setHeader("content-type","application/json");
    return res.status(502).json({ ok:false, error:"pollinations_failed", details:String(e).slice(0,200) });
  }
  const { bytes, ctype } = bin;
  const jpegBytes = ctype.includes("jpeg") ? bytes : await toJPEG(bytes);

  // Supabase upload
  let ensureSupabaseClient, getSupabaseServiceRole, sb, randomUUID;
  try {
    ({ ensureSupabaseClient, getSupabaseServiceRole } = await import("../lib/supabase.mjs"));
    ({ randomUUID } = await import("node:crypto"));
    sb = getSupabaseServiceRole(); ensureSupabaseClient(sb, "service");
  } catch (e) {
    return res.status(500).json({ ok:false, error:"supabase_module_load_failed", details:String(e).slice(0,200) });
  }

  const d = new Date();
  const yyyy = d.getUTCFullYear(), mm = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
  const uploadType = "image/jpeg";
  const fileKey = `${STYLE_VERSION}${fast ? "-fast" : ""}-s${seed}-${W}x${H}-${(randomUUID?.() || Math.random().toString(36).slice(2))}.jpg`;
  const path = `outputs/${yyyy}-${mm}-${dd}/${fileKey}`;

  const up = await sb.storage.from(BUCKET).upload(path, jpegBytes, {
    contentType: uploadType, upsert: false, cacheControl: CACHE_CONTROL
  });
  if (up.error) return res.status(500).json({ ok:false, error:"upload_failed", details:String(up.error).slice(0,200) });

  let imageUrl;
  const finalPath = up?.data?.path || path;
  if (OUTPUT_PUBLIC) {
    imageUrl = sb.storage.from(BUCKET).getPublicUrl(finalPath).data.publicUrl;
  } else {
    const s = await sb.storage.from(BUCKET).createSignedUrl(finalPath, SIGNED_TTL_S);
    if (s.error) return res.status(500).json({ ok:false, error:"signed_url_failed", details:String(s.error).slice(0,200) });
    imageUrl = s.data.signedUrl;
  }

  // Debug compare (optionnel)
  let debug;
  if (toBool(body?.debug_compare)) {
    try {
      const crypto = await import("node:crypto");
      const provider_sha256 = crypto.createHash("sha256").update(jpegBytes).digest("hex");
      const noCacheUrl = imageUrl + (imageUrl.includes("?") ? "&" : "?") + "nocache=" + Date.now();
      const r = await fetch(noCacheUrl);
      const supaBuf = Buffer.from(await r.arrayBuffer());
      const supabase_sha256 = crypto.createHash("sha256").update(supaBuf).digest("hex");
      debug = {
        compare: provider_sha256 === supabase_sha256 ? "IDENTICAL" : "DIFFERENT",
        provider_sha256, provider_bytes: jpegBytes.length,
        supabase_sha256, supabase_bytes: supaBuf.length,
        supabase_content_type: r.headers.get("content-type") || "",
        storage_path: finalPath, url_checked: noCacheUrl
      };
    } catch (e) {
      debug = { compare:"ERROR", error:String(e).slice(0,200) };
    }
  }

  res.setHeader("content-type","application/json");
  const payload = { ok:true, mode:"save", image_url:imageUrl, width:W, height:H, fast:!!fast, ...(debug?{debug}:{}) };
  if (idem) globalThis.__idemCache.set(idem, payload);
  console.log(JSON.stringify({ level:"info", reqId, event:"save_done", path: finalPath }));
  return res.status(200).json(payload);
}
