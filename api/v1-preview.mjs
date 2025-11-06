// /api/v1-preview.mjs — Previews only, fast, safe=false by default (no storage)
// Modes:
// - Preview (défaut): JSON { ok, mode:"preview", provider_url, width, height, seed, fast }
// - proxy:true       : image/jpeg binaire — pour Figma (blob)
//
// ENV optionnels: POLLINATIONS_TOKEN, PREVIEW_CACHE_CONTROL_S, MAX_FUNCTION_S, MIN_IMAGE_BYTES, PREVIEW_ENHANCE
// Reco client: fast:true, ratio:"1:1", px:384|512, seed aléatoire, safe:false (look mode/décolleté)

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
const CACHE_CONTROL   = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);
const PREVIEW_ENHANCE = (process.env.PREVIEW_ENHANCE ?? "false") === "true";
const MIN_IMAGE_BYTES = Number(process.env.MIN_IMAGE_BYTES || 1024);

const MAX_FUNCTION_S   = Number(process.env.MAX_FUNCTION_S || 25);
const SAFETY_MARGIN_S  = Number(process.env.SAFETY_MARGIN_S || 3);
const TIME_BUDGET_MS   = Math.max(5000, (MAX_FUNCTION_S - SAFETY_MARGIN_S) * 1000);
const POL_TIMEOUT_MS   = Math.max(4000, Math.min(TIME_BUDGET_MS - 1500, 15000));

/* ---------------------------- Helpers --------------------------- */
const ok     = v => typeof v === "string" && v.trim().length > 0;
const toBool = v => v === true || v === "true" || v === "1" || v === 1;
const clamp  = (n, min, max) => Math.max(min, Math.min(max, Math.floor(Number(n) || 0)));

const BG=["studio","office","city","nature"];
const OUTFIT=["blazer","shirt","tee","athleisure"];
const RATIO=["1:1","3:4"];
const SKIN=["light","fair","medium","tan","deep"];
const HAIR_COLOR=["black","brown","blonde","red","gray","none"];
const HAIR_LEN=["short","medium","long","bald"];
const EYE=["brown","blue","green","hazel","gray"];
const BODY_TYPE=["slim","athletic","average","curvy"];
const BUST_SIZE=["small","medium","large"];
const BUTT_SIZE=["small","medium","large"];
const MOOD=["neutral","friendly","confident","cool","serious","approachable"];

const STYLE_VERSION = "ig_influencer_v1";
const POL_ENDPOINT  = "https://image.pollinations.ai/prompt";

const SIZE_FAST = { "1:1":[576,576], "3:4":[576,768] };
const SIZE_HQ   = { "1:1":[896,896], "3:4":[896,1152] };

const round64 = n => Math.max(64, Math.round(n/64)*64);
function dimsFromPx(px, ratio){
  const p = clamp(px, 128, 1024);
  return ratio==="3:4" ? [round64(p), round64(p*4/3)] : [round64(p), round64(p)];
}
const hash = s => { let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h+(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))>>>0 } return h>>>0; };

/* ------------------------ Normalisation ------------------------- */
function normalizeForm(raw) {
  const f = raw && typeof raw==="object" ? raw : {};
  const gender     = ["woman","man"].includes(f.gender) ? f.gender : "woman";
  const background = BG.includes(f.background) ? f.background : "studio";
  const outfitKey  = OUTFIT.includes(f.outfit) ? f.outfit : "tee";
  const ratio      = RATIO.includes(f.ratio) ? f.ratio : "1:1";
  const skin       = SKIN.includes(f.skin_tone) ? f.skin_tone : "medium";
  const hairLength = HAIR_LEN.includes(f.hair_length) ? f.hair_length : "short";
  const eyeColor   = EYE.includes(f.eye_color) ? f.eye_color : "brown";
  let   hairColor  = HAIR_COLOR.includes(f.hair_color) ? f.hair_color : "brown";
  if (hairLength === "bald") hairColor = "none";
  const bodyType   = BODY_TYPE.includes(f.body_type) ? f.body_type : "average";
  const bustSize   = BUST_SIZE.includes(f.bust_size) ? f.bust_size : "medium";
  const buttSize   = BUTT_SIZE.includes(f.butt_size) ? f.butt_size : "medium";
  const mood       = MOOD.includes(f.mood) ? f.mood : "neutral";
  const includeHips= Boolean(f.waist_up || /waist|3\/4|three/.test(String(f.framing||"")));
  const key = `${background}|${outfitKey}|${skin}|${hairLength}|${hairColor}|${eyeColor}|${bodyType}|${bustSize}|${buttSize}|${mood}|${includeHips?"hips":"-"}`
  return { gender, background, outfitKey, ratio, skin, hairLength, hairColor, eyeColor, bodyType, bustSize, buttSize, mood, includeHips, key };
}
function deriveSeed(userSeed, n, extra=""){
  if (Number.isFinite(Number(userSeed))) return Math.floor(Number(userSeed));
  const base=hash(`${STYLE_VERSION}|${n.key}|${n.ratio}|${extra}`);
  return (base || 777) >>> 0;
}

/* ------------------------ Prompt builder ------------------------ */
// On garde "instagram influencer aesthetic", avec bust/hips si fournis.
function buildPrompt(n){
  const BG_MAP={studio:"white studio background", office:"modern office background", city:"subtle city background", nature:"soft outdoor background"};
  const OUTFIT_MAP={
    blazer:"tailored blazer",
    shirt:"button-up shirt",
    tee:"fitted tee",
    athleisure:"sleeveless fitted tank top"
  };
  const subject = n.gender==="man" ? "man" : "woman";
  const outfit  = OUTFIT_MAP[n.outfitKey];
  const hair    = n.hairLength==="bald" ? "clean-shaven head" : `${n.hairLength} ${n.hairColor} hair`;
  const moodMap = { neutral:"neutral expression", friendly:"friendly expression", confident:"confident look", cool:"calm composed look", serious:"serious expression", approachable:"approachable slight smile" };
  const mood    = moodMap[n.mood] || "neutral expression";
  const framing = n.includeHips ? "waist-up" : "shoulders-up";

  const chestW  = { small:"subtle chest profile", medium:"balanced chest profile", large:"fuller chest profile" };
  const chestM  = { small:"slim chest",           medium:"balanced chest",        large:"broad chest" };
  const hips    = { small:"narrow hips",          medium:"balanced hips",         large:"fuller hips" };
  const chest   = (n.gender==="woman" ? chestW : chestM)[n.bustSize];
  const hipsD   = hips[n.buttSize];

  return [
    `photorealistic instagram influencer aesthetic portrait, youthful adult (25–35) ${subject}`,
    `${n.skin} skin, ${n.bodyType} build`,
    `${hair}, ${n.eyeColor} eyes`,
    `wearing ${outfit}`,
    chest, n.includeHips ? hipsD : null,
    `${mood}, looking at camera`,
    BG_MAP[n.background],
    "soft beauty lighting, studio-quality retouching, 85mm portrait look, shallow depth of field",
    `${framing}, clean framing, natural skin texture`,
    "no watermark, no text, no celebrity likeness"
  ].filter(Boolean).join(", ");
}

/* --------------------- Provider (HTTP GET fast) ----------------- */
async function fetchWithTimeout(url, init={}, timeoutMs=POL_TIMEOUT_MS){
  if (typeof AbortSignal!=="undefined" && "timeout" in AbortSignal) {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const ac=new AbortController(); const t=setTimeout(()=>ac.abort("timeout"), timeoutMs);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}
const isJPEG = b => b.length>3  && b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF;
const isPNG  = b => b.length>8  && b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47 && b[4]===0x0D && b[5]===0x0A && b[6]===0x1A && b[7]===0x0A;
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
  return { bytes, ctype: ctype.includes("png") ? "image/png" : ctype.includes("webp") ? "image/webp" : "image/jpeg" };
}

function buildProviderURL({ prompt, width, height, seed, safe, negative_prompt }){
  const qs = new URLSearchParams({
    model: "flux",
    width: String(width),
    height: String(height),
    seed: String(seed),
    private: "true",
    nologo: "true",
    nofeed: "true",
    enhance: PREVIEW_ENHANCE ? "true" : "false",
    quality: "medium",
    ...(typeof safe === "string" ? { safe } : {}), // "false" par défaut fixé plus bas
    negative_prompt: String(negative_prompt || "") // jamais "undefined"
  }).toString();
  return `${POL_ENDPOINT}/${encodeURIComponent(prompt)}?${qs}`;
}

async function fetchProviderBinary(url){
  const headers = { Accept:"image/*", "User-Agent":"Photoglow-Preview/1.0" };
  if (POL_TOKEN) headers.Authorization = `Bearer ${POL_TOKEN}`;
  const res = await fetchWithTimeout(url, { method:"GET", headers }, POL_TIMEOUT_MS);
  return await readImageResponse(res);
}

async function toJPEG(bytes){
  try {
    const sharpMod = await import("sharp");
    const sharp = (sharpMod.default || sharpMod);
    return await sharp(Buffer.from(bytes)).jpeg({ quality: 92 }).toBuffer();
  } catch {
    return Buffer.from(bytes);
  }
}

/* ------------------------------ API ----------------------------- */
export default async function handler(req, res){
  setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok:true, endpoint:"/api/v1-preview", style_version: STYLE_VERSION,
      cache_control: CACHE_CONTROL, enhance: PREVIEW_ENHANCE, min_image_bytes: MIN_IMAGE_BYTES
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

  // Normalisation
  const n = normalizeForm(body);

  // Vitesse / dimensions
  const strict = toBool(body.strict);
  const fastDefault = !strict;
  const fast = toBool(body.fast ?? fastDefault);

  let [W,H] = (fast ? (SIZE_FAST[n.ratio]||[576,576]) : (SIZE_HQ[n.ratio]||[896,896]));
  const pxDims = body.px ? dimsFromPx(body.px, n.ratio) : null;
  if (pxDims) [W,H] = pxDims; else if (!strict && !body.px) [W,H] = dimsFromPx(384, n.ratio);

  // Prompt + seed
  const prompt = ok(body.prompt) ? String(body.prompt) : buildPrompt(n);
  const seed   = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : deriveSeed(body.seed, n, "ig|85mm");

  // safe=false par défaut (important pour looks mode/décolleté)
  let safeStr = "false";
  if (typeof body.safe !== "undefined") safeStr = toBool(body.safe) ? "true" : "false";

  // Negative prompt : optionnel (on ne bride pas par défaut)
  const neg = ok(body.negative_prompt) ? String(body.negative_prompt) : "";

  // PREVIEW JSON — rapide
  const isProxy = toBool(body.proxy);
  const provider_url = buildProviderURL({ prompt, width: W, height: H, seed, safe: safeStr, negative_prompt: neg });

  if (!isProxy) {
    res.setHeader("content-type","application/json");
    return res.status(200).json({ ok:true, mode:"preview", provider_url, width:W, height:H, seed, fast });
  }

  // PROXY — binaire (Figma)
  try {
    const { bytes, ctype } = await fetchProviderBinary(provider_url);
    const out = ctype.includes("jpeg") ? bytes : await toJPEG(bytes);
    res.setHeader("content-type","image/jpeg");
    res.setHeader("cache-control","no-store");
    res.setHeader("x-safe", safeStr);
    return res.status(200).send(out);
  } catch (e) {
    res.setHeader("content-type","application/json");
    return res.status(502).json({ ok:false, mode:"proxy", error:"pollinations_failed", details:String(e).slice(0,200) });
  }
}
