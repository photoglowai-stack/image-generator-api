// /api/v1-preview.mjs
export const config = { runtime: "nodejs" };

import { setCORS } from "../lib/http.mjs";
import { ensureSupabaseClient, getSupabaseServiceRole } from "../lib/supabase.mjs";

/* ---------- Supabase ---------- */
const sb = getSupabaseServiceRole();

/* ---------- ENV ---------- */
const POL_TOKEN  = process.env.POLLINATIONS_TOKEN || "";
const BUCKET     = process.env.PREVIEW_BUCKET || "generated_images";
const OUTPUT_PUBLIC = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S  = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7);
const CACHE_CONTROL = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);
const DEFAULT_SEED  = Number(process.env.PREVIEW_SEED || 777);

/* ---------- Helpers & vocab ---------- */
const ok = (v) => typeof v === "string" && v.trim().length > 0;
const clamp = (v, arr, d = 0) => (ok(v) && arr.includes(v) ? v : arr[d]);

const BG = ["studio","office","city","nature"];
const OUTFIT = ["blazer","shirt","tee","athleisure"];
const MOOD = ["warm","neutral","cool"];
const RATIO = ["1:1","3:4"];
const SKIN = ["light","fair","medium","tan","deep"];
const HAIR_COLOR = ["black","brown","blonde","red","gray"];
const HAIR_LEN = ["short","medium","long"];
const EYE = ["brown","blue","green","hazel","gray"];
const BODY = ["slim","athletic","average","curvy","muscular"];

const SIZE = { "1:1": [640, 640], "3:4": [720, 960] };

/* ---------- Cache key (discrétisée) ---------- */
function exactKey(form) {
  const gender = clamp(form?.gender, ["woman","man"], 0);
  const preset = clamp(form?.preset, ["linkedin_pro","ceo_office","lifestyle_warm","speaker_press"]);
  const bg     = clamp(form?.background, BG);
  const outfit = clamp(form?.outfit, OUTFIT);
  const mood   = clamp(form?.mood, MOOD, 1);
  const ratio  = clamp(form?.aspect_ratio, RATIO);
  const skin   = clamp(form?.skin_tone ?? form?.skin, SKIN, 2);
  const hairC  = clamp(form?.hair_color ?? form?.hair, HAIR_COLOR, 1);
  const hairL  = clamp(form?.hair_length ?? form?.hairLen, HAIR_LEN, 2);
  const eyes   = clamp(form?.eye_color ?? form?.eyes, EYE, 0);
  const body   = clamp(form?.body_type, BODY, 2); // average par défaut
  // Inclut body_type pour 3:4 ; inoffensif pour 1:1
  return `${gender}|${preset}|${bg}|${outfit}|${mood}|${ratio}|${skin}|${hairC}|${hairL}|${eyes}|${body}`;
}

/* ---------- Prompt universelle ---------- */
function subjectFromGender(g) {
  return g === "man" ? "portrait of an adult man" : "portrait of an adult woman";
}
function outfitLabel(outfit, gender) {
  if (outfit === "athleisure") {
    return gender === "man"
      ? "fitted athletic t-shirt (athleisure look)"
      : "neutral sports bra and athleisure look";
  }
  return { blazer:"navy blazer and white shirt", shirt:"smart shirt", tee:"clean crew-neck tee" }[outfit];
}
function buildPrompt(form) {
  const gender = clamp(form?.gender, ["woman","man"], 0);
  const subject = subjectFromGender(gender);

  const bgMap = {
    studio:"neutral seamless light-gray studio background",
    office:"modern office bokeh background",
    city:"city bokeh background",
    nature:"subtle green foliage bokeh background",
  };
  const bg = bgMap[clamp(form?.background, BG)];
  const outfit = outfitLabel(clamp(form?.outfit, OUTFIT), gender);
  const mood = { warm:"warm approachable mood", neutral:"confident approachable mood", cool:"calm professional mood" }[clamp(form?.mood, MOOD, 1)];

  const skin   = clamp(form?.skin_tone ?? form?.skin, SKIN, 2);
  const hairC  = clamp(form?.hair_color ?? form?.hair, HAIR_COLOR, 1);
  const hairL  = clamp(form?.hair_length ?? form?.hairLen, HAIR_LEN, 2);
  const eyes   = clamp(form?.eye_color ?? form?.eyes, EYE, 0);
  const ratio  = clamp(form?.aspect_ratio, RATIO, 0);
  const body   = clamp(form?.body_type, BODY, 2);

  const parts = [
    subject,
    "professional studio headshot, head-and-shoulders",
    "soft diffused light, 85mm portrait look, shallow depth of field",
    bg,
    outfit,
    mood,
    // body type discret uniquement si 3:4 (buste visible)
    ...(ratio === "3:4" ? [`subtle ${body} build`] : []),
    `natural ${skin} skin tone, ${hairL}-length ${hairC} hair, ${eyes} eyes`,
    "natural realistic skin texture, sharp eyes, photo-realistic",
  ];
  return parts.join(", ");
}

/* ---------- Upload Supabase ---------- */
async function uploadToSupabase(path, bytes) {
  const up = await sb.storage.from(BUCKET).upload(path, bytes, {
    contentType: "image/jpeg",
    upsert: true,
    cacheControl: CACHE_CONTROL
  });
  if (up.error) throw up.error;

  if (OUTPUT_PUBLIC) {
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } else {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_S);
    if (error) throw error;
    return data.signedUrl;
  }
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ ok:false, error:"method_not_allowed" });

  try {
    if (!sb) return res.status(500).json({ ok:false, error:"missing_env_supabase" });
    ensureSupabaseClient(sb, "service");
    const form = (req.body && typeof req.body === "object") ? req.body : {};
    const key  = exactKey(form);
    const seed = Number.isFinite(Number(form?.seed)) ? Math.max(0, Math.floor(Number(form.seed))) : DEFAULT_SEED;
    const ratio = clamp(form?.aspect_ratio, RATIO);
    const [W, H] = SIZE[ratio] || [640, 640];
    const prompt = buildPrompt(form);

    // 0) Cache
    const cached = await sb.from("preview_cache").select("image_url,hits").eq("key", key).maybeSingle();
    if (cached.data?.image_url) {
      await sb.from("preview_cache").update({ hits: (cached.data.hits||0)+1 }).eq("key", key).catch(()=>{});
      return res.status(200).json({ ok:true, image_url: cached.data.image_url, provider:"cache", seed, key });
    }

    // 1) Pollinations (model=flux)
    const base = "https://image.pollinations.ai/prompt/";
    const qs   = `?model=flux&width=${W}&height=${H}&seed=${seed}&private=true&enhance=true${POL_TOKEN ? "&nologo=true" : ""}`;
    const url  = `${base}${encodeURIComponent(prompt)}${qs}`;

    const r = await fetch(url, {
      headers: POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {},
      signal: AbortSignal.timeout(60_000)
    });
    if (!r.ok) {
      const msg = await r.text().catch(()=> "");
      return res.status(r.status).json({ ok:false, error:"pollinations_failed", details: msg.slice(0,400) });
    }
    const bytes = Buffer.from(await r.arrayBuffer());

    // 2) Upload + cache
    const path = `previews/${encodeURIComponent(key)}.jpg`;
    const imageUrl = await uploadToSupabase(path, bytes);
    await sb.from("preview_cache").insert({ key, image_url: imageUrl }).catch(()=>{});

    return res.status(200).json({ ok:true, image_url: imageUrl, provider:"pollinations", seed, key });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"server_error", details: String(e).slice(0,400) });
  }
}
