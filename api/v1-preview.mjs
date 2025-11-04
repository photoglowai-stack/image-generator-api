// /api/v1-preview.mjs — No-Storage Preview (Provider URL by default, optional Proxy Binary)
// - Default: provider_only → return Pollinations URL (no storage, fastest path)
// - Optional: proxy_only  → fetch image bytes from Pollinations and return binary (no storage)
// - Strict mode: can force a raw prompt (skips builder) if body.strict=true + body.prompt
// - Hard validation in proxy path: content-type image/* & minimum size
// - GET → health/status, POST → preview
// - No Supabase import/usage whatsoever

export const config = { runtime: "nodejs", maxDuration: 25 };

/* ----------------------------- CORS ----------------------------- */
function setCORS(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ------------------------------ ENV ----------------------------- */
const POL_TOKEN       = process.env.POLLINATIONS_TOKEN || "";
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
const DEFAULT_SEED  = Number(process.env.PREVIEW_SEED || 777);

// simple FNV-like hash for deterministic picks
const hash = (s) => { let h = 2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=(h+(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24))>>>0 } return h>>>0; };
const pick = (arr, h) => arr[h % arr.length];

/* -------------------- Normalisation + seed ---------------------- */
function normalizeForm(raw) {
  const form = raw && typeof raw === "object" ? raw : {};
  const gender     = clamp(form.gender ?? form.sex, ["woman","man"], 1);        // défaut: man
  const background = clamp(form.background ?? form.bg ?? form.scene, BG, 0);    // studio
  const outfitKey  = clamp(form.outfit ?? form.outfitKey ?? form.style, OUTFIT, 2); // tee
  const ratio      = clamp(form.aspect_ratio ?? form.aspectRatio ?? form.ratio, RATIO, 1); // 3:4
  const skin       = clamp(form.skin_tone ?? form.skinTone ?? form.skin, SKIN, 2); // medium
  const hairLength = clamp(form.hair_length ?? form.hairLength ?? form.hairLen, HAIR_LEN, 0); // short
  const eyeColor   = clamp(form.eye_color ?? form.eyeColor ?? form.eyes, EYE, 0);

  let hairColor    = clamp(form.hair_color ?? form.hairColor ?? form.hair, HAIR_COLOR, 1); // brown
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

function buildPollinationsUrl({ prompt, width, height, seed, safe }) {
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

async function readImageResponse(res) {
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`pollinations_http_${res.status}_${txt.slice(0,160)}`);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  const ab = await res.arrayBuffer();
  const bytes = Buffer.from(ab);

  // Validation dure: content-type image/* ET taille minimale
  if (!/^image\//.test(ctype) || bytes.length < 24 * 1024) {
    const preview = bytes.toString("utf8", 0, Math.min(bytes.length, 160));
    throw new Error(`pollinations_unexpected_${ctype || "unknown"}_len${bytes.length}_${preview}`);
  }
  return { bytes, ctype: ctype.includes("png") ? "image/png" : ctype.includes("webp") ? "image/webp" : "image/jpeg" };
}

async function fetchPollinationsBinary({ url }) {
  const baseHeaders = { Accept: "image/*", "User-Agent": "Photoglow-Preview/1.0" };
  if (POL_TOKEN) baseHeaders.Authorization = `Bearer ${POL_TOKEN}`;

  // Tentatives avec backoff
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

/* ------------------------------ API ----------------------------- */
export default async function handler(req, res) {
  setCORS(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok:true, endpoint:"/v1/preview",
      mode_default:"provider_only",
      supports_proxy_only:true,
      poll_token:Boolean(POL_TOKEN),
      enhance: PREVIEW_ENHANCE,
      time_budget_ms: TIME_BUDGET_MS,
      poll_timeout_ms: POL_TIMEOUT_MS
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

  // Flags
  const strict     = toBool(body?.strict);
  const proxyOnly  = toBool(body?.proxy_only);
  // provider_only est implicite par défaut quand proxy_only n'est pas demandé

  // Normalisation & prompt
  const n = normalizeForm(body);
  const fast = toBool(body?.fast ?? !strict); // en strict on tend à HQ
  const [W,H] = (fast ? SIZE_FAST : SIZE_HQ)[n.ratio] || (fast ? [576,576] : [896,896]);
  const prompt = strict && ok(body.prompt) ? String(body.prompt) : (ok(body?.prompt) ? String(body.prompt) : buildPrompt(n));
  const seed   = deriveSeed(body?.seed, n, `${n.framing}|${n.lighting}|${n.lens}`);
  const safe   = toBool(body?.safe ?? true) ? "true" : "false";

  // 1) Construire l'URL provider (toujours)
  const providerUrl = buildPollinationsUrl({ prompt, width: W, height: H, seed, safe });

  // 2A) Chemin provider_only (défaut) → renvoyer juste l'URL (aucun téléchargement côté serveur)
  if (!proxyOnly) {
    res.setHeader("content-type","application/json");
    return res.status(200).json({
      ok:true, mode:"provider_only",
      provider_url: providerUrl,
      seed, width: W, height: H, fast: !!fast
    });
  }

  // 2B) Chemin proxy_only → télécharger + renvoyer le binaire au client (toujours sans stockage)
  try {
    const { bytes, ctype } = await fetchPollinationsBinary({ url: providerUrl });

    // Cache client raisonnable (le provider peut être déterministe via seed)
    res.setHeader("content-type", ctype);
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    // Optionnel : exposer quelques headers utiles côté client
    res.setHeader("x-photoglow-mode", "proxy_only");
    res.setHeader("x-photoglow-seed", String(seed));
    res.setHeader("x-photoglow-size", `${W}x${H}`);

    return res.status(200).end(bytes);
  } catch (e) {
    res.setHeader("content-type","application/json");
    return res.status(502).json({ ok:false, error:"pollinations_failed", details:String(e).slice(0,200) });
  }
}
