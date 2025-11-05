// /api/v1-preview.mjs — Preview-by-default (no storage unless save:true)
// Résumé modes:
// - Preview (défaut): JSON { provider_url } — rapide (front)
// - proxy:true       : image/jpeg binaire — pour Figma
// - save:true        : download -> upload Supabase -> JSON { image_url }
//
// ENV requis:
// POLLINATIONS_TOKEN (optionnel), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// PREVIEW_BUCKET=generated_images, OUTPUT_PUBLIC=true, PREVIEW_CACHE_CONTROL_S=31536000
// MAX_FUNCTION_S=25, MIN_IMAGE_BYTES=1024

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
const MIN_IMAGE_BYTES = Number(process.env.MIN_IMAGE_BYTES || 1024);

const MAX_FUNCTION_S   = Number(process.env.MAX_FUNCTION_S || 25);
const SAFETY_MARGIN_S  = Number(process.env.SAFETY_MARGIN_S || 3);
const TIME_BUDGET_MS   = Math.max(5000, (MAX_FUNCTION_S - SAFETY_MARGIN_S) * 1000);
const POL_TIMEOUT_MS   = Math.max(4000, Math.min(TIME_BUDGET_MS - 1500, 18000));

/* ---------------------- Anti-spam & idem ------------------------ */
const RATE_WINDOW_MS = 10_000, RATE_MAX = 10;
const _seen = new Map();
function rateLimit(req) {
  const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || "anon").trim();
  const now = Date.now();
  const arr = (_seen.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now); _seen.set(ip, arr);
  if (arr.length > RATE_MAX) { const e = new Error("rate_limited"); e.status = 429; throw e; }
}
function idemKey(req) { return String(req.headers["idempotency-key"] || ""); }
globalThis.__idemCache ||= new Map();

/* ---------------------------- Helpers --------------------------- */
const ok = v => typeof v === "string" && v.trim().length > 0;
const toBool = v => v === true || v === "true" || v === "1" || v === 1;
const clamp  = (v, arr, d = 0) => (ok(v) && arr.includes(v) ? v : arr[d]);

const BG=["studio","office","city","nature"];
const OUTFIT=["blazer","shirt","tee","athleisure"];
const RATIO=["1:1","3:4"];
const SKIN=["light","fair","medium","tan","deep"];
const HAIR_COLOR=["black","brown","blonde","red","gray"];
const HAIR_LEN=["short","medium","long","bald"];
const EYE=["brown","blue","green","hazel","gray"];

const BODY_TYPE=["slim","athletic","curvy","average"];
const BUST_SIZE=["small","medium","large"];
const BUTT_SIZE=["small","medium","large"];
const MOOD=["neutral","friendly","confident","cool","serious","approachable"];

const SIZE_HQ   = { "1:1":[896,896], "3:4":[896,1152] };
const SIZE_FAST = { "1:1":[576,576], "3:4":[576,768] };
const STYLE_VERSION = "commercial_photo_v4";

const hash = s => { let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h+(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))>>>0 } return h>>>0; };
const round64 = n => Math.max(64, Math.round(n/64)*64);
function dimsFromPx(px, ratio){ const p=Math.max(128, Math.min(1024, Number(px)||0)); if(!p) return null; return ratio==="3:4" ? [round64(p), round64(p*4/3)] : [round64(p), round64(p)]; }

/* -------------------- Normalisation + seed ---------------------- */
function normalizeForm(raw) {
  const f = raw && typeof raw==="object" ? raw : {};
  const gender = clamp(f.gender ?? f.sex, ["woman","man"], 1);
  const background = clamp(f.background ?? f.bg ?? f.scene, BG, 0);
  const outfitKey  = clamp(f.outfit ?? f.outfitKey ?? f.style, OUTFIT, 2);
  const ratio      = clamp(f.aspect_ratio ?? f.aspectRatio ?? f.ratio, RATIO, 1);
  const skin       = clamp(f.skin_tone ?? f.skinTone ?? f.skin, SKIN, 2);
  const hairLength = clamp(f.hair_length ?? f.hairLength ?? f.hairLen, HAIR_LEN, 0);
  const eyeColor   = clamp(f.eye_color ?? f.eyeColor ?? f.eyes, EYE, 0);

  let hairColor = clamp(f.hair_color ?? f.hairColor ?? f.hair, HAIR_COLOR, 1);
  if (hairLength === "bald") hairColor = "none";

  const bodyType = clamp((f.body_type ?? f.bodyType), BODY_TYPE, 3);
  const bustSize = clamp((f.bust_size ?? f.bustSize), BUST_SIZE, 1);
  const buttSize = clamp((f.butt_size ?? f.buttSize), BUTT_SIZE, 1);
  const mood     = clamp((f.mood ?? f.expression ?? f.vibe), MOOD, 2);

  const framingStr = String(f.framing || "").toLowerCase();
  const includeHips = toBool(f.waist_up) || /waist|three|3\/4/.test(framingStr);

  const styleKey = `${background}|${outfitKey}|${skin}|${hairLength}|${hairColor}|${eyeColor}|${bodyType}|${bustSize}|${mood}|${includeHips?"hips":"-"}`;
  return { gender, background, outfitKey, ratio, skin, hairColor, hairLength, eyeColor, bodyType, bustSize, buttSize, mood, includeHips, styleKey };
}
function deriveSeed(userSeed, n, extra=""){ if(Number.isFinite(Number(userSeed))) return Math.floor(Number(userSeed)); const base=hash(`${STYLE_VERSION}|${n.styleKey}|${n.ratio}|${extra}`); return ((base + (n.gender==="woman"?0:7919))>>>0) || DEFAULT_SEED; }

/* ------------------------ Prompt builder ------------------------ */
function buildPrompt(n){
  const BG_MAP={studio:"white seamless studio background", office:"modern office background", city:"subtle city background", nature:"soft outdoor background"};
  const OUTFIT_W={blazer:"tailored blazer", shirt:"fitted blouse", tee:"crew-neck tee", athleisure:"athleisure sports top"};
  const OUTFIT_M={blazer:"tailored blazer", shirt:"fitted shirt",  tee:"crew-neck tee", athleisure:"athletic performance top"};
  const SKIN_MAP={light:"light skin tone", fair:"fair skin tone", medium:"medium skin tone", tan:"tan skin tone", deep:"deep skin tone"};
  const EYE_MAP ={brown:"brown eyes", blue:"blue eyes", green:"green eyes", hazel:"hazel eyes", gray:"gray eyes"};

  const subject = n.gender==="woman" ? "confident professional woman" : "confident professional man";
  const outfit  = (n.gender==="woman"?OUTFIT_W:OUTFIT_M)[n.outfitKey];
  const hair    = n.hairLength==="bald" ? "clean-shaven head" : `${n.hairLength} ${n.hairColor} hair`;
  const bodyMap = { slim:"slim build", athletic:"athletic build", curvy:"curvy build", average:"average build" };
  const chestW = { small:"subtle chest profile", medium:"balanced chest profile", large:"fuller chest profile" };
  const chestM = { small:"slim chest", medium:"balanced chest", large:"broad chest" };
  const hips   = { small:"narrow hips", medium:"balanced hips", large:"fuller hips" };
  const chest  = (n.gender==="woman" ? chestW : chestM)[n.bustSize] || (n.gender==="woman" ? "balanced chest profile" : "balanced chest");
  const hipsD  = hips[n.buttSize] || "balanced hips";
  const moodMap={neutral:"neutral expression",friendly:"gentle friendly expression",confident:"confident look",cool:"calm composed look",serious:"serious expression",approachable:"approachable slight smile"};
  const mood   = moodMap[n.mood] || "confident look";
  const framing= n.includeHips ? "waist-up portrait" : "headshot from shoulders up";

  let prompt = [
    `editorial portrait of a ${subject}, adult (25+), fully clothed`,
    BG_MAP[n.background], outfit, hair, SKIN_MAP[n.skin], EYE_MAP[n.eyeColor],
    bodyMap[n.bodyType] || "balanced build", chest, n.includeHips ? hipsD : null,
    mood, "soft neutral lighting", "85mm look, shallow depth of field",
    framing, "photorealistic, clean composition, natural skin texture"
  ].filter(Boolean).join(", ");

  if (prompt.length > 220) prompt = prompt.replace(", photorealistic, clean composition, natural skin texture", "");
  if (prompt.length > 220) prompt = prompt.replace(", 85mm look, shallow depth of field", "");
  return prompt;
}

/* --------------------- Pollinations (HTTP) ---------------------- */
const POL_ENDPOINT = "https://image.pollinations.ai/prompt";

async function fetchWithTimeout(url, init={}, timeoutMs=POL_TIMEOUT_MS){
  if (timeoutMs <= 0) throw new Error("invalid_timeout");
  if (typeof AbortSignal!=="undefined" && "timeout" in AbortSignal) return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const ac=new AbortController(); const t=setTimeout(()=>ac.abort("timeout"), timeoutMs);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}
// signatures binaires (pour accepter petits JPEG)
const isJPEG = b => b.length>3 && b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF;
const isPNG  = b => b.length>8 && b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47 && b[4]===0x0D && b[5]===0x0A && b[6]===0x1A && b[7]===0x0A;
const isWEBP = b => b.length>12 && b.slice(0,4).toString()==="RIFF" && b.slice(8,12).toString()==="WEBP";

async function readImageResponse(res){
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`pollinations_http_${res.status}_${txt.slice(0,160)}`);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  const ab = await res.arrayBuffer();
  const bytes = Buffer.from(ab);

  if (!/^image\//.test(ctype)) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 160));
    throw new Error(`pollinations_unexpected_${ctype || "unknown"}_len${bytes.length}_${preview}`);
  }
  const looksLike = isJPEG(bytes) || isPNG(bytes) || isWEBP(bytes);
  if (!looksLike) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 160));
    throw new Error(`pollinations_unexpected_${ctype}_len${bytes.length}_${preview}`);
  }
  // ⚠️ tolère les petites previews (ex. 8–12 KB)
  if (bytes.length < MIN_IMAGE_BYTES && bytes.length < 1024) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 160));
    throw new Error(`pollinations_unexpected_small_${ctype}_len${bytes.length}_${preview}`);
  }
  return { bytes, ctype: ctype.includes("png") ? "image/png" : ctype.includes("webp") ? "image/webp" : "image/jpeg" };
}

function buildProviderURL({ prompt, width, height, seed, safe }){
  const qs = new URLSearchParams({
    model:"flux", width:String(width), height:String(height), seed:String(seed),
    private:"true", nologo:"true", enhance: PREVIEW_ENHANCE ? "true" : "false", safe
  }).toString();
  return `${POL_ENDPOINT}/${encodeURIComponent(prompt)}?${qs}`;
}

async function fetchPollinationsBinary({ prompt, width, height, seed, safe }){
  const baseHeaders = { Accept:"image/*", "User-Agent":"Photoglow-Preview/1.0" };
  if (POL_TOKEN) baseHeaders.Authorization = `Bearer ${POL_TOKEN}`;
  const url = buildProviderURL({ prompt, width, height, seed, safe });
  let lastErr;
  for (let i=0;i<=2;i++){
    try {
      const res = await fetchWithTimeout(url, { method:"GET", headers: baseHeaders });
      return await readImageResponse(res);
    } catch (e) {
      lastErr = e; await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error("pollinations_failed");
}

async function toJPEG(bytes){
  try { const sharpMod = await import("sharp"); const sharp = (sharpMod.default || sharpMod);
        return await sharp(Buffer.from(bytes)).jpeg({ quality: 92 }).toBuffer(); }
  catch { return Buffer.from(bytes); }
}

/* ------------------------------ API ----------------------------- */
export default async function handler(req, res){
  setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    const hasUrl = Boolean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
    const hasSrv = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    return res.status(200).json({
      ok:true, endpoint:"/api/v1-preview",
      style_version: STYLE_VERSION, min_image_bytes: MIN_IMAGE_BYTES,
      has_supabase_url:hasUrl, has_service_role:hasSrv,
      bucket:BUCKET, output_public:OUTPUT_PUBLIC, poll_token:Boolean(POL_TOKEN)
    });
  }

  if (req.method !== "POST") {
    res.setHeader("content-type","application/json");
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== "object") body = {};

  try { rateLimit(req); } catch (e) { res.setHeader("content-type","application/json"); return res.status(e.status||429).json({ ok:false, error:"rate_limited" }); }

  const idem = idemKey(req);
  const strict = toBool(body?.strict);
  const proxy  = toBool(body?.proxy);
  const save   = toBool(body?.save);

  if (idem && globalThis.__idemCache.has(idem)) {
    const cached = globalThis.__idemCache.get(idem);
    res.setHeader("content-type","application/json");
    return res.status(200).json(cached);
  }

  // Normalisation & tailles
  const n = normalizeForm(body);
  const fastDefault = !strict;
  const fast = toBool(body?.fast ?? fastDefault);
  let [W,H] = (fast ? SIZE_FAST : SIZE_HQ)[n.ratio] || (fast ? [576,576] : [896,896]);
  const pxDims = dimsFromPx(body?.px, n.ratio); if (pxDims && !save) { [W,H] = pxDims; }
  if (strict) {
    const bw = Number(body.width), bh = Number(body.height);
    if (Number.isFinite(bw) && Number.isFinite(bh) && bw>=64 && bh>=64) { W=Math.floor(bw); H=Math.floor(bh); }
  }

  const prompt = strict && ok(body.prompt) ? String(body.prompt) : (ok(body?.prompt) ? String(body.prompt) : buildPrompt(n));
  const seed   = strict && Number.isFinite(Number(body?.seed)) ? Math.floor(Number(body.seed)) : deriveSeed(body?.seed, n, "editorial|soft|85mm");
  const safe   = toBool(body?.safe ?? true) ? "true" : "false";

  // Preview JSON
  if (!save && !proxy) {
    const provider_url = buildProviderURL({ prompt, width: W, height: H, seed, safe });
    res.setHeader("content-type","application/json");
    return res.status(200).json({ ok:true, mode:"preview", provider_url, width:W, height:H, fast:!!fast });
  }

  // Proxy binaire (Figma)
  if (!save && proxy) {
    try {
      const { bytes, ctype } = await fetchPollinationsBinary({ prompt, width: W, height: H, seed, safe });
      const out = ctype.includes("jpeg") ? bytes : await toJPEG(bytes);
      res.setHeader("content-type","image/jpeg");
      res.setHeader("cache-control","no-store");
      res.setHeader("x-bytes", String(out.length));
      res.setHeader("x-min-image-bytes", String(MIN_IMAGE_BYTES));
      return res.status(200).send(out);
    } catch (e) {
      res.setHeader("content-type","application/json");
      return res.status(502).json({ ok:false, mode:"proxy", error:"pollinations_failed", details:String(e).slice(0,200) });
    }
  }

  // SAVE (upload Supabase)
  let bin;
  try { bin = await fetchPollinationsBinary({ prompt, width: W, height: H, seed, safe }); }
  catch (e) { res.setHeader("content-type","application/json"); return res.status(502).json({ ok:false, error:"pollinations_failed", details:String(e).slice(0,200) }); }

  const { bytes, ctype } = bin;
  const jpegBytes = ctype.includes("jpeg") ? bytes : await toJPEG(bytes);

  let ensureSupabaseClient, getSupabaseServiceRole, sb, randomUUID;
  try {
    ({ ensureSupabaseClient, getSupabaseServiceRole } = await import("../lib/supabase.mjs"));
    ({ randomUUID } = await import("node:crypto"));
    sb = getSupabaseServiceRole(); ensureSupabaseClient(sb, "service");
  } catch (e) {
    return res.status(500).json({ ok:false, error:"supabase_module_load_failed", details:String(e).slice(0,200) });
  }

  const d = new Date();
  const yyyy=d.getUTCFullYear(), mm=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
  const fileKey = `${STYLE_VERSION}${fast?"-fast":""}-s${seed}-${W}x${H}-${(randomUUID?.() || Math.random().toString(36).slice(2))}.jpg`;
  const path = `outputs/${yyyy}-${mm}-${dd}/${fileKey}`;

  const up = await sb.storage.from(BUCKET).upload(path, jpegBytes, { contentType:"image/jpeg", upsert:false, cacheControl:CACHE_CONTROL });
  if (up.error) return res.status(500).json({ ok:false, error:"upload_failed", details:String(up.error).slice(0,200) });

  let imageUrl;
  const finalPath = up?.data?.path || path;
  if (OUTPUT_PUBLIC) imageUrl = sb.storage.from(BUCKET).getPublicUrl(finalPath).data.publicUrl;
  else {
    const s = await sb.storage.from(BUCKET).createSignedUrl(finalPath, SIGNED_TTL_S);
    if (s.error) return res.status(500).json({ ok:false, error:"signed_url_failed", details:String(s.error).slice(0,200) });
    imageUrl = s.data.signedUrl;
  }

  // Debug optionnel
  let debug;
  if (toBool(body?.debug_compare)) {
    try {
      const crypto = await import("node:crypto");
      const provider_sha256 = crypto.createHash("sha256").update(jpegBytes).digest("hex");
      const noCacheUrl = imageUrl + (imageUrl.includes("?") ? "&" : "?") + "nocache=" + Date.now();
      const r = await fetch(noCacheUrl);
      const supaBuf = Buffer.from(await r.arrayBuffer());
      const supabase_sha256 = crypto.createHash("sha256").update(supaBuf).digest("hex");
      debug = { compare: provider_sha256===supabase_sha256 ? "IDENTICAL" : "DIFFERENT", provider_sha256, provider_bytes: jpegBytes.length, supabase_sha256, supabase_bytes: supaBuf.length, storage_path: finalPath };
    } catch (e) { debug = { compare:"ERROR", error:String(e).slice(0,200) }; }
  }

  res.setHeader("content-type","application/json");
  const payload = { ok:true, mode:"save", image_url:imageUrl, width:W, height:H, fast:!!fast, ...(debug?{debug}:{}) };
  if (idem) globalThis.__idemCache.set(idem, payload);
  return res.status(200).json(payload);
}
