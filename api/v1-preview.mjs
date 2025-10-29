// /api/v1-preview.mjs — Final V3.7 (beauty_v2)
// 🧯 Self-contained CORS (no http.mjs)
// 🔐 Cold-start safe: dynamic import of supabase.mjs inside POST only
// ✅ GET health-check (200) even with missing ENV
// ✅ Robust body parsing (string → JSON), prompt fallback if missing
// ✅ Beauty-tuned prompt (young adult, studio beauty lighting, catchlights)
// ✅ Seed & size in cache key + STYLE_VERSION for cache-bust
// ✅ Accepts camelCase + snake_case (Figma compat)
// ✅ Pollinations: nologo=true, private=true, enhance=true
// ✅ Fallback timeout when AbortSignal.timeout is unavailable

export const config = { runtime: "nodejs" };

/* ---------- CORS (inline) ---------- */
function setCORS(req, res, opts = {}) {
  res.setHeader("access-control-allow-origin", "*"); // Figma (Origin: null) OK
  res.setHeader("access-control-allow-methods", opts.allowMethods || "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", opts.allowHeaders || "content-type, authorization, idempotency-key");
  res.setHeader("access-control-max-age", "86400");
}

/* ---------- ENV ---------- */
const POL_TOKEN      = process.env.POLLINATIONS_TOKEN || ""; // optional
const BUCKET         = process.env.PREVIEW_BUCKET || "generated_images";
const OUTPUT_PUBLIC  = (process.env.OUTPUT_PUBLIC || "true") === "true";
const SIGNED_TTL_S   = Number(process.env.OUTPUT_SIGNED_TTL_S || 60 * 60 * 24 * 7);
const CACHE_CONTROL  = String(process.env.PREVIEW_CACHE_CONTROL_S || 31536000);
const DEFAULT_SEED   = Number(process.env.PREVIEW_SEED || 777);

/* ---------- Helpers & vocab ---------- */
const ok = (v) => typeof v === "string" && v.trim().length > 0;
const clamp = (v, arr, d = 0) => (ok(v) && arr.includes(v) ? v : arr[d]);

const BG = ["studio","office","city","nature"];
const OUTFIT = ["blazer","shirt","tee","athleisure"];
const MOOD = ["warm","neutral","cool"];
const RATIO = ["1:1","3:4"];
const SKIN = ["light","fair","medium","tan","deep"];
const HAIR_COLOR = ["black","brown","blonde","red","gray"];
const HAIR_LEN = ["short","medium","long","bald"]; // bald support
const EYE = ["brown","blue","green","hazel","gray"];
const BODY = ["slim","athletic","average","curvy","muscular"];

/* ↑ Légère montée de résolution pour plus de netteté */
const SIZE = { "1:1": [768, 768], "3:4": [768, 1024] };

/* ---------- Cache key ---------- */
const STYLE_VERSION = "beauty_v2"; // change this to bust the preview cache

function exactKey(form) {
  const gender = clamp(form?.gender, ["woman","man"], 0);
  const preset = clamp(form?.preset, ["linkedin_pro","ceo_office","lifestyle_warm","speaker_press"]);
  const bg     = clamp(form?.background, BG);
  const outfit = clamp(form?.outfit, OUTFIT);
  const mood   = clamp(form?.mood, MOOD, 1);
  const ratio  = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO);
  const skin   = clamp(form?.skin_tone ?? form?.skinTone ?? form?.skin, SKIN, 2);
  const hairC  = clamp(form?.hair_color ?? form?.hairColor ?? form?.hair, HAIR_COLOR, 1);
  const hairL  = clamp(form?.hair_length ?? form?.hairLength ?? form?.hairLen, HAIR_LEN, 2);
  const eyes   = clamp(form?.eye_color ?? form?.eyeColor ?? form?.eyes, EYE, 0);
  const body   = clamp(form?.body_type ?? form?.bodyType, BODY, 2);
  return `${gender}|${preset}|${bg}|${outfit}|${mood}|${ratio}|${skin}|${hairC}|${hairL}|${eyes}|${body}`;
}

/* ---------- Prompt (beauty) ---------- */
function subjectFromGender(g) { return g === "man" ? "young adult man (mid-20s to early-30s)" : "young adult woman (mid-20s to early-30s)"; }
function outfitLabel(outfit, gender) {
  if (outfit === "athleisure") return gender === "man" ? "fitted athletic t-shirt (athleisure look)" : "neutral athleisure top";
  return { blazer:"navy blazer and white shirt", shirt:"smart shirt", tee:"clean crew-neck tee" }[outfit];
}
function buildPrompt(form) {
  const gender = clamp(form?.gender, ["woman","man"], 0);
  const subject = subjectFromGender(gender);

  const bgMap = {
    studio:"white seamless studio background",
    office:"modern office bokeh background",
    city:"city bokeh background",
    nature:"soft green foliage bokeh background",
  };
  const bg = bgMap[clamp(form?.background, BG)];
  const outfit = outfitLabel(clamp(form?.outfit, OUTFIT), gender);
  const mood = { warm:"warm approachable mood", neutral:"confident approachable mood", cool:"calm professional mood" }[clamp(form?.mood, MOOD, 1)];

  const skin   = clamp(form?.skin_tone ?? form?.skinTone ?? form?.skin, SKIN, 2);
  const hairC  = clamp(form?.hair_color ?? form?.hairColor ?? form?.hair, HAIR_COLOR, 1);
  const hairL  = clamp(form?.hair_length ?? form?.hairLength ?? form?.hairLen, HAIR_LEN, 2);
  const eyes   = clamp(form?.eye_color ?? form?.eyeColor ?? form?.eyes, EYE, 0);
  const ratio  = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO, 0);
  const body   = clamp(form?.body_type ?? form?.bodyType, BODY, 2);

  const hairPhrase = hairL === "bald" ? "bald" : `healthy ${hairL} ${hairC} hair`;

  const beautyCommon = [
    "high-end editorial beauty photo, face-centered composition, eyes to camera",
    "studio beauty lighting with large octabox key and subtle rim light, bright catchlights",
    "youthful fresh look, even luminous skin with gentle highlights",
    "subtle professional skin retouch, pore-level detail preserved, flattering but realistic",
    "crisp sharp eyes, clean color balance, smooth tonal transitions"
  ];
  const beautyGender = gender === "woman"
    ? ["soft glam natural makeup, defined eyes and brows, hydrated lips, subtle blush"]
    : ["clean shave or neat light stubble, groomed brows, natural matte skin finish"];

  return [
    `professional waist-up portrait of a ${subject}`,
    "85mm portrait look, shallow depth of field",
    bg, outfit, mood,
    ...(ratio === "3:4" ? [`subtle ${body} build`] : []),
    `natural ${skin} skin tone, ${eyes} eyes, ${hairPhrase}`,
    ...beautyCommon,
    ...beautyGender,
    "award-winning editorial quality, photorealistic, clean background"
  ].join(", ");
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET")     return res.status(200).json({ ok:true, ready:true, endpoint:"/api/v1-preview" });
  if (req.method !== "POST")    return res.status(405).json({ ok:false, error:"method_not_allowed" });

  // 🔌 Dynamic import to avoid cold-start crashes when ENV are missing on GET
  let ensureSupabaseClient, getSupabaseServiceRole, sb;
  try {
    ({ ensureSupabaseClient, getSupabaseServiceRole } = await import("../supabase.mjs"));
  } catch (e) {
    return res.status(500).json({ ok:false, error:"supabase_module_load_failed", details: String(e).slice(0,200) });
  }

  try {
    try { sb = getSupabaseServiceRole(); }
    catch { return res.status(500).json({ ok:false, error:"missing_env_supabase" }); }
    ensureSupabaseClient(sb, "service");

    // --- tolerant body parsing + prompt fallback ---
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const form = (body && typeof body === "object") ? body : {};
    if (!ok(form?.prompt)) form.prompt = buildPrompt(form);

    // --- render settings ---
    const ratio = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO);
    const [W, H] = SIZE[ratio] || [768, 768];
    const seed = Number.isFinite(Number(form?.seed)) ? Math.max(0, Math.floor(Number(form.seed))) : DEFAULT_SEED;
    const prompt = String(form.prompt);

    // --- cache key (versioned) ---
    const key = `${STYLE_VERSION}|${exactKey(form)}|seed:${seed}|${W}x${H}`;

    // 0) Cache lookup
    const cached = await sb.from("preview_cache").select("image_url,hits").eq("key", key).maybeSingle();
    if (cached.data?.image_url) {
      await sb.from("preview_cache").update({ hits: (cached.data.hits||0)+1 }).eq("key", key).catch(()=>{});
      return res.status(200).json({ ok:true, image_url: cached.data.image_url, provider:"cache", seed, key });
    }

    // 1) Generation (Pollinations FLUX)
    const q = new URLSearchParams({
      model: "flux",
      width: String(W), height: String(H),
      seed: String(seed),
      private: "true",
      enhance: "true",
      nologo: "true",
    }).toString();
    const url  = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`;
    const headers = POL_TOKEN ? { Authorization: `Bearer ${POL_TOKEN}` } : {};

    let r;
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    } else {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort('timeout'), 60_000);
      try { r = await fetch(url, { headers, signal: ac.signal }); }
      finally { clearTimeout(t); }
    }
    if (!r.ok) {
      const msg = await r.text().catch(()=> "");
      return res.status(r.status).json({ ok:false, error:"pollinations_failed", details: msg.slice(0,400) });
    }
    const bytes = Buffer.from(await r.arrayBuffer());

    // 2) Upload + cache insert (Supabase Storage)
    const { data: pub } = await sb.storage.getBucket(BUCKET);
    if (!pub) return res.status(500).json({ ok:false, error:"bucket_not_found", bucket: BUCKET });

    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth()+1).padStart(2,'0');
    const dd = String(d.getUTCDate()).padStart(2,'0');
    const path = `previews/${yyyy}-${mm}-${dd}/${encodeURIComponent(key)}.jpg`;

    const up = await sb.storage.from(BUCKET).upload(path, bytes, {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: CACHE_CONTROL,
    });
    if (up.error) return res.status(500).json({ ok:false, error:"upload_failed", details: String(up.error).slice(0,200) });

    let imageUrl;
    if (OUTPUT_PUBLIC) {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      imageUrl = data.publicUrl;
    } else {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_S);
      if (error) return res.status(500).json({ ok:false, error:"signed_url_failed", details: String(error).slice(0,200) });
      imageUrl = data.signedUrl;
    }

    await sb.from("preview_cache").insert({ key, image_url: imageUrl }).catch(()=>{});
    return res.status(200).json({ ok:true, image_url: imageUrl, provider:"pollinations", seed, key });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"server_error", details: String(e).slice(0,400) });
  }
}
