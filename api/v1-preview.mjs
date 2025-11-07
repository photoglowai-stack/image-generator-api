// /api/v1-preview.mjs
// Photoglow — v1 (previews only, no storage)
// Modes:
//  - Preview (default): JSON { ok, mode:"preview", provider_url, width, height, seed, fast }
//  - Proxy (Figma)    : proxy:true → image/jpeg binaire
//
// Objectifs : vitesse, cadrage contrôlé (CU), seed ultra-stable (par genre),
// "safe" = false (FORCÉ), negative anti close-up, qualité “ultra-clean” (px min 512).
//
// ENV optionnels: POLLINATIONS_TOKEN, PREVIEW_ENHANCE, MAX_FUNCTION_S, MIN_IMAGE_BYTES, PREVIEW_MIN_PX
export const config = { runtime: "nodejs", maxDuration: 25 };

/* ----------------------------- CORS ----------------------------- */
function setCORS(req, res) {
  const origin = req.headers.origin;
  const allow = (!origin || origin === "null") ? "null" : origin;
  res.setHeader("access-control-allow-origin", allow);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "POST,OPTIONS,GET");
  res.setHeader("access-control-allow-headers", "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
  // Expose headers for Figma (Origin:null)
  res.setHeader("Access-Control-Expose-Headers", "x-provider-url, x-provider-dims, x-seed, x-framing, x-ratio, x-px");
}

/* ------------------------------ ENV ----------------------------- */
const POL_TOKEN        = process.env.POLLINATIONS_TOKEN || "";
const PREVIEW_ENHANCE  = (process.env.PREVIEW_ENHANCE ?? "false") === "true";
const MIN_IMAGE_BYTES  = Number(process.env.MIN_IMAGE_BYTES || 1024);
const MAX_FUNCTION_S   = Number(process.env.MAX_FUNCTION_S || 25);
const PREVIEW_MIN_PX   = Number(process.env.PREVIEW_MIN_PX || 512);   // qualité min 512px
const SAFETY_MARGIN_S  = 3;
const TIME_BUDGET_MS   = Math.max(5000, (MAX_FUNCTION_S - SAFETY_MARGIN_S) * 1000);
const POL_TIMEOUT_MS   = Math.max(4000, Math.min(TIME_BUDGET_MS - 1500, 15000));

/* ---------------------------- Helpers --------------------------- */
const ok     = v => typeof v === "string" && v.trim().length > 0;
const toBool = v => v === true || v === "true" || v === 1 || v === "1";
const clamp  = (n, min, max) => Math.max(min, Math.min(max, Math.floor(Number(n) || 0)));
const round64 = n => Math.max(64, Math.round(n/64)*64);

function dimsFromPx(px, ratio) {
  const p = clamp(px, 128, 1024);
  if (ratio === "3:4") return [round64(p), round64(p * 4/3)];
  return [round64(p), round64(p)];
}

async function fetchWithTimeout(url, init = {}, timeoutMs = POL_TIMEOUT_MS) {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  const ac = new AbortController(); const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// quick content sniff
const isJPEG = b => b.length>3  && b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF;
const isPNG  = b => b.length>8  && b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47 && b[4]===0x0D && b[5]===0x0A && b[6]===0x1A && b[7]===0x0A;
const isWEBP = b => b.length>12 && b.slice(0,4).toString()==="RIFF" && b.slice(8,12).toString()==="WEBP";

async function readImageResponse(res) {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`pollinations_http_${res.status}_${txt.slice(0,160)}`);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  const ab = await res.arrayBuffer();
  const bytes = Buffer.from(ab);

  if (!/^image\//.test(ctype)) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 200));
    throw new Error(`pollinations_unexpected_${ctype || "unknown"}_len${bytes.length}_${preview}`);
  }
  const looksLike = isJPEG(bytes) || isPNG(bytes) || isWEBP(bytes);
  if (!looksLike) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 200));
    throw new Error(`pollinations_unexpected_${ctype}_len${bytes.length}_${preview}`);
  }
  if (bytes.length < MIN_IMAGE_BYTES) {
    // tolère petits JPEG
  }
  return { bytes, ctype: ctype.includes("png") ? "image/png" : ctype.includes("webp") ? "image/webp" : "image/jpeg" };
}

async function toJPEG(bytes) {
  try {
    const sharpMod = await import("sharp");
    const sharp = (sharpMod.default || sharpMod);
    return await sharp(Buffer.from(bytes)).jpeg({ quality: 92 }).toBuffer();
  } catch {
    return Buffer.from(bytes);
  }
}

/* ---------------------- Domain: attributes ---------------------- */
const BG      = ["studio","office","city","nature"];
const OUTFIT  = ["blazer","shirt","tee","athleisure"];
const RATIO   = ["1:1","3:4"];
const GENDER  = ["woman","man"];
const SKIN    = ["light","fair","medium","tan","deep"];
const HAIRLEN = ["short","medium","long","bald"];
const HAIRCOL = ["black","brown","blonde","red","gray","none"];
const EYES    = ["brown","blue","green","hazel","gray"];
const BODY    = ["athletic","slim","average","curvy"];
const BUST    = ["small","medium","large"];    // femmes
const BUTT    = ["small","medium","large"];
const MOOD    = ["neutral","friendly","confident","cool","serious","approachable"];
const FRAME   = ["hs","cu","wu"];
const NECK    = ["crew","vneck","scoop","plunge","strapless","sleeveless"];

/* -------------------- Normalisation + seed ---------------------- */
function normalize(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  const gender     = GENDER.includes(f.gender) ? f.gender : "woman";
  const background = BG.includes(f.background) ? f.background : "studio";
  const outfit     = OUTFIT.includes(f.outfit) ? f.outfit : "tee";
  let   ratio      = RATIO.includes(f.ratio) ? f.ratio : "1:1";
  const skin_tone  = SKIN.includes(f.skin_tone) ? f.skin_tone : (f.skin_tone === "olive" ? "medium" : "medium");

  // Defaults visuels corrects par genre
  let hair_length  = HAIRLEN.includes(f.hair_length) ? f.hair_length : (gender === "woman" ? "long" : "short");
  let hair_color   = HAIRCOL.includes(f.hair_color) ? f.hair_color : "brown";
  if (hair_length === "bald") hair_color = "none";

  const eye_color  = EYES.includes(f.eye_color) ? f.eye_color : "brown";
  let   body_type  = BODY.includes(f.body_type) ? f.body_type
                    : ((f.body_type === "muscular" || f.body_type === "fit") ? "athletic" : "average");
  let   bust_size  = BUST.includes(f.bust_size) ? f.bust_size : "medium";
  if (f.bust_size === "average") bust_size = "medium";
  let   butt_size  = BUTT.includes(f.butt_size) ? f.butt_size : "medium";
  if (f.butt_size === "average") butt_size = "medium";
  const mood       = MOOD.includes(f.mood) ? f.mood : "confident";

  // cadrage (sera surverrouillé CU + 1:1 au handler)
  const framing    = FRAME.includes((f.framing || "").toLowerCase()) ? (f.framing || "hs").toLowerCase() : "hs";
  if (!ok(f.ratio) && framing === "wu") ratio = "3:4";

  const neckline   = NECK.includes(f.neckline) ? f.neckline : undefined;

  let px           = clamp(f.px ?? PREVIEW_MIN_PX, 128, 1024);
  if (px < PREVIEW_MIN_PX) px = PREVIEW_MIN_PX;

  const fast       = f.fast !== undefined ? toBool(f.fast) : true;
  const safe       = false; // force

  const shuffle    = toBool(f.shuffle);
  const negative_prompt = ok(f.negative_prompt) ? String(f.negative_prompt) : "";

  // Seed ultra-stable : par genre (optionnellement random si shuffle=true)
  let seed;
  if (Number.isFinite(Number(f.seed)))      seed = Math.floor(Number(f.seed));
  else if (shuffle)                         seed = randomSeed();
  else                                      seed = deriveSeedFromKey("gender:" + gender);

  return {
    gender, background, outfit, ratio, skin_tone, hair_length, hair_color, eye_color,
    body_type, bust_size, butt_size, mood, framing, neckline, px, fast, safe,
    negative_prompt, seed
  };
}

function fnv1a32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
function deriveSeedFromKey(key){ return fnv1a32("PGv1|" + key); }
function randomSeed(){
  const u = new Uint32Array(1);
  try { (globalThis.crypto?.getRandomValues?.(u)); } catch {}
  return (u[0] || Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

/* ------------------------ Prompt builder ------------------------ */
function buildPrompt(n, customPrompt) {
  if (ok(customPrompt)) return customPrompt.trim();

  const bgMap = { studio:"white studio background", office:"modern office background", city:"subtle city background", nature:"soft outdoor background" };

  const framingTxt = "chest-up framing (upper torso and both shoulders visible), medium camera distance, balanced headroom";

  // Outfit + neckline (femmes → wording fashion)
  let outfitText = n.outfit;
  if (n.gender === "woman") {
    if (n.outfit === "athleisure") {
      outfitText = (n.neckline === "vneck" || n.neckline === "scoop")
        ? "sleeveless fitted tank top, tasteful low neckline (v-neck / scoop), subtle cleavage"
        : (n.neckline === "plunge" || n.neckline === "strapless")
        ? "fashion top with plunge/strapless design, tasteful low neckline, subtle cleavage"
        : (n.neckline === "sleeveless")
        ? "sleeveless fitted tank top"
        : "fitted athletic top";
    } else if (n.outfit === "shirt") {
      outfitText = (n.neckline === "vneck") ? "fitted blouse with modest v-neck" : "fitted blouse";
    } else if (n.outfit === "tee") {
      outfitText = (n.neckline === "vneck") ? "fitted v-neck tee" : "fitted crew-neck tee";
    } else if (n.outfit === "blazer") {
      outfitText = "tailored blazer over fitted top";
    }
  } else {
    if (n.outfit === "tee") outfitText = "fitted crew-neck tee";
    if (n.outfit === "shirt") outfitText = "fitted shirt";
    if (n.outfit === "blazer") outfitText = "tailored blazer";
    if (n.outfit === "athleisure") outfitText = "athletic top";
  }

  const moodMap = {
    neutral:"neutral expression", friendly:"friendly expression",
    confident:"confident look",  cool:"calm composed look",
    serious:"serious expression", approachable:"approachable slight smile"
  };

  const subject = n.gender === "man" ? "man" : "woman";
  const hair = n.hair_length === "bald" ? "clean-shaven head" : `${n.hair_length} ${n.hair_color} hair`;
  const bodyMap = { slim:"slim", athletic:"athletic", curvy:"curvy", average:"average" };

  const chestW  = { small:"subtle chest profile", medium:"balanced chest profile", large:"fuller chest profile" };
  const chestM  = { small:"slim chest", medium:"balanced chest", large:"broad chest" };
  const hips    = { small:"narrow hips", medium:"balanced hips", large:"fuller hips" };
  const chest   = (n.gender === "woman" ? chestW : chestM)[n.bust_size] || (n.gender==="woman" ? "balanced chest profile" : "balanced chest");
  const hipsD   = hips[n.butt_size] || "balanced hips";

  const parts = [
    "photorealistic instagram influencer aesthetic portrait",
    framingTxt,
    `youthful adult (25–35) ${subject}, ${n.skin_tone} skin, ${bodyMap[n.body_type]} build`,
    `${hair}, ${n.eye_color} eyes`,
    `wearing ${outfitText}`,
    chest, /* CU: optionnel */ (n.framing !== "hs" ? hipsD : null),
    `${moodMap[n.mood] || "confident look"}, looking at camera`,
    bgMap[n.background] || "white studio background",
    "sharp focus, micro-contrast, detailed eyes, natural skin texture",
    "soft beauty lighting, 85mm portrait look, clean composition, high detail",
    "no text, no watermark, no celebrity likeness"
  ].filter(Boolean);

  return parts.join(", ");
}

function defaultNegative(n, customNeg){
  if (ok(customNeg)) return customNeg.trim();
  return "extreme close-up, face-only, tight crop, zoomed-in face, forehead cut, chin cut, cropped hairline, soft focus, blur, low-res, jpeg artifacts";
}

/* --------------------- Provider: Pollinations ------------------- */
const POL_ENDPOINT = "https://image.pollinations.ai/prompt";

function buildProviderURL({ prompt, width, height, seed, safe, negative_prompt }) {
  const qs = new URLSearchParams({
    model: "flux",
    width: String(width),
    height: String(height),
    seed: String(seed >>> 0),
    private: "true",
    nologo: "true",
    nofeed: "true",
    enhance: PREVIEW_ENHANCE ? "true" : "false",
    safe: safe ? "true" : "false",
    quality: "medium", // la netteté vient surtout du px et d'enhance
    negative_prompt: String(negative_prompt || "")
  }).toString();
  return `${POL_ENDPOINT}/${encodeURIComponent(prompt)}?${qs}`;
}

/* -------- Retry provider (même seed, backoff court) -------- */
async function fetchProviderBinaryWithRetry(url, tries = 2){
  const headers = { Accept:"image/*", "User-Agent":"Photoglow-Preview/1.0" };
  if (POLL_TOKEN) headers.Authorization = `Bearer ${POLL_TOKEN}`;
  let lastErr;
  for (let i = 0; i <= tries; i++) {
    try {
      const res = await fetchWithTimeout(url, { method:"GET", headers }, POL_TIMEOUT_MS);
      return await readImageResponse(res);
    } catch (e){
      lastErr = e;
      if (i < tries) await new Promise(r => setTimeout(r, 300 * (i+1))); // backoff
    }
  }
  throw lastErr;
}

/* ------------------------------ API ----------------------------- */
export default async function handler(req, res){
  setCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok:true, endpoint:"/api/v1-preview",
      notes:"preview only (no storage), proxy for Figma",
      defaults:{ fast:true, safe:false, px:PREVIEW_MIN_PX, ratio:"1:1", framing:"cu" }
    });
  }

  if (req.method !== "POST") {
    res.setHeader("content-type","application/json");
    return res.status(405).json({ ok:false, error:"method_not_allowed" });
  }

  // Parse body JSON (Vercel/Node runtime)
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== "object") body = {};

  try {
    // 1) normalize & verrous qualité/variabilité
    const n = normalize(body);
    n.safe    = false;     // force
    n.ratio   = "1:1";     // lock
    n.framing = "cu";      // lock (Chest-Up unique)
    if (n.px < PREVIEW_MIN_PX) n.px = PREVIEW_MIN_PX; // min 512

    const [W,H] = dimsFromPx(n.px, n.ratio);
    const prompt = buildPrompt(n, body.prompt);
    const negative_prompt = defaultNegative(n, body.negative_prompt);
    const seed = n.seed;

    // 2) Build URL + expose headers (debug/front)
    const provider_url = buildProviderURL({ prompt, width: W, height: H, seed, safe: false, negative_prompt });
    res.setHeader("x-provider-url", provider_url);
    res.setHeader("x-provider-dims", `${W}x${H}`);
    res.setHeader("x-seed", String(seed));
    res.setHeader("x-framing", n.framing);
    res.setHeader("x-ratio", n.ratio);
    res.setHeader("x-px", String(n.px));
    console.log("[v1-preview]", { provider_url, dims:`${W}x${H}`, seed, framing:n.framing, ratio:n.ratio, px:n.px });

    // 3) Proxy or Preview
    if (toBool(body.proxy)) {
      try {
        const { bytes, ctype } = await fetchProviderBinaryWithRetry(provider_url);
        const out = ctype.includes("jpeg") ? bytes : await toJPEG(bytes);
        res.setHeader("content-type","image/jpeg");
        res.setHeader("cache-control","no-store");
        return res.status(200).send(out);
      } catch (e) {
        res.setHeader("content-type","application/json");
        return res.status(502).json({
          ok:false, mode:"proxy", error:"pollinations_failed",
          provider_url, details:String(e).slice(0,200)
        });
      }
    }

    // Preview JSON
    res.setHeader("content-type","application/json");
    return res.status(200).json({
      ok:true, mode:"preview", provider_url, width:W, height:H, seed, fast:n.fast
    });

  } catch (e) {
    res.setHeader("content-type","application/json");
    return res.status(500).json({ ok:false, error:"server_error", message:String(e).slice(0,200) });
  }
}
