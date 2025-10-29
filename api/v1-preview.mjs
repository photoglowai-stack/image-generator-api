// /api/v1-preview.mjs — Final V3.8 (sexy_sfw_fast)
// 🧯 Self-contained CORS (no http.mjs)
// 🔐 Cold-start safe: dynamic import of supabase.mjs inside POST only
// ✅ GET health-check (200) even with missing ENV
// ✅ Robust body parsing (string → JSON), prompt fallback if missing
// ✅ Beauty/Glam prompt (SFW) for man & woman
// ✅ Versioned cache key (STYLE_VERSION) + seed + size
// ✅ FAST MODE: set body.fast=true (or "1") → smaller size ⇒ faster
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
const toBool = (v) => v === true || v === "true" || v === "1" || v === 1;

const BG = ["studio","office","city","nature"];
const OUTFIT = ["blazer","shirt","tee","athleisure"];
const MOOD = ["warm","neutral","cool"];
const RATIO = ["1:1","3:4"];
const SKIN = ["light","fair","medium","tan","deep"];
const HAIR_COLOR = ["black","brown","blonde","red","gray"];
const HAIR_LEN = ["short","medium","long","bald"]; // bald support
const EYE = ["brown","blue","green","hazel","gray"];
const BODY = ["slim","athletic","average","curvy","muscular"];

/* ---------- Render sizes ---------- */
/* Quality mode (par défaut) – net et vendeur */
const SIZE_HQ = { "1:1": [896, 896], "3:4": [896, 1152] };
/* Fast mode – plus petit ⇒ plus rapide pour la prévisualisation */
const SIZE_FAST = { "1:1": [640, 640], "3:4": [672, 896] };

/* ---------- Cache version ---------- */
const STYLE_VERSION = "sexy_sfw_v1";

/* ---------- Cache key (discretized + seed/size) ---------- */
function exactKey(form) {
  const gender = clamp(form?.gender, ["woman","man"], 0);
  const preset = clamp(form?.preset, ["linkedin_pro","ceo_office","lifestyle_warm","speaker_press"]);
  const bg     = clamp(form?.background, BG);
  const outfit = clamp(form?.outfit, OUTFIT);
  const mood   = clamp(form?.mood, MOOD, 1);
  const ratio  = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO, 0);
  const skin   = clamp(form?.skin_tone ?? form?.skinTone ?? form?.skin, SKIN, 2);
  const hairC  = clamp(form?.hair_color ?? form?.hairColor ?? form?.hair, HAIR_COLOR, 1);
  const hairL  = clamp(form?.hair_length ?? form?.hairLength ?? form?.hairLen, HAIR_LEN, 2);
  const eyes   = clamp(form?.eye_color ?? form?.eyeColor ?? form?.eyes, EYE, 0);
  const body   = clamp(form?.body_type ?? form?.bodyType, BODY, 2);
  return `${gender}|${preset}|${bg}|${outfit}|${mood}|${ratio}|${skin}|${hairC}|${hairL}|${eyes}|${body}`;
}

/* ---------- Prompt (sexy SFW) ---------- */
function subjectFromGender(g) {
  return g === "man"
    ? "young adult man (mid-20s to early-30s)"
    : "young adult woman (mid-20s to early-30s)";
}
function outfitLabel(outfit, gender) {
  // SFW mais plus "vendeur" (fitted / fashion-commercial)
  if (outfit === "athleisure") {
    return gender === "man"
      ? "sleek fitted athletic tee (athleisure)"
      : "form-fitting athleisure top";
  }
  return {
    blazer: gender === "man"
      ? "tailored navy blazer over fitted shirt"
      : "tailored blazer over fitted top",
    shirt: gender === "man"
      ? "well-fitted dark dress shirt, top button open"
      : "fitted smart shirt or top",
    tee: "clean fitted crew-neck tee",
  }[outfit];
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
  const bg     = bgMap[clamp(form?.background, BG)];
  const outfit = outfitLabel(clamp(form?.outfit, OUTFIT), gender);
  const mood   = { warm:"warm welcoming mood", neutral:"confident approachable mood", cool:"cool stylish mood" }[clamp(form?.mood, MOOD, 1)];

  const skin  = clamp(form?.skin_tone ?? form?.skinTone ?? form?.skin, SKIN, 2);
  const hairC = clamp(form?.hair_color ?? form?.hairColor ?? form?.hair, HAIR_COLOR, 1);
  const hairL = clamp(form?.hair_length ?? form?.hairLength ?? form?.hairLen, HAIR_LEN, 2);
  const eyes  = clamp(form?.eye_color ?? form?.eyeColor ?? form?.eyes, EYE, 0);
  const ratio = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO, 0);
  const body  = clamp(form?.body_type ?? form?.bodyType, BODY, 2);

  const hairPhrase = hairL === "bald" ? "clean bald" : `healthy ${hairL} ${hairC} hair`;

  const sexyCommon = [
    "fashion-commercial portrait, slight three-quarter angle, relaxed confident posture",
    "studio beauty lighting: large octabox key plus soft rim light, bright catchlights",
    "youthful fresh look, luminous skin glow, even tone",
    "very subtle professional skin retouch (no plastic look), refined highlights",
    "defined cheekbones, flattering jawline, crisp sharp eyes",
    "high-end editorial quality, photorealistic, clean background"
  ];
  const sexyGender = gender === "woman"
    ? ["soft glam natural makeup, defined eyes and brows, hydrated lips"]
    : ["light neat stubble or clean shave, groomed brows, healthy matte finish"];

  return [
    `waist-up portrait of a ${subject}, camera-facing with a subtle inviting smile`,
    "85mm portrait look, shallow depth of field",
    bg, outfit, mood,
    ...(ratio === "3:4" ? [`subtle ${body} build`] : []),
    `natural ${skin} skin tone, ${eyes} eyes, ${hairPhrase}`,
    ...sexyCommon,
    ...sexyGender
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

  // Import dynamique (évite les crashs de cold-start si ENV manquants sur GET)
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
    const fast = toBool(form?.fast); // ⇢ active le mode rapide
    const ratio = clamp(form?.aspect_ratio ?? form?.aspectRatio, RATIO, 0);
    const [W, H] = (fast ? SIZE_FAST : SIZE_HQ)[ratio] || (fast ? [640,640] : [896,896]);
    const seed = Number.isFinite(Number(form?.seed)) ? Math.max(0, Math.floor(Number(form.seed))) : DEFAULT_SEED;
    const prompt = String(form.prompt);

    // --- cache key (versioned + fast flag) ---
    const key = `${STYLE_VERSION}${fast ? "|fast" : ""}|${exactKey(form)}|seed:${seed}|${W}x${H}`;

    // 0) Cache lookup
    const cached = await sb.from("preview_cache").select("image_url,hits").eq("key", key).maybeSingle();
    if (cached.data?.image_url) {
      await sb.from("preview_cache").update({ hits: (cached.data.hits||0)+1 }).eq("key", key).catch(()=>{});
      return res.status(200).json({ ok:true, image_url: cached.data.image_url, provider:"cache", seed, key, fast: !!fast });
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
      r = await fetch(url, { headers, signal: AbortSignal.timeout(fast ? 30_000 : 60_000) });
    } else {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort('timeout'), fast ? 30_000 : 60_000);
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
    return res.status(200).json({ ok:true, image_url: imageUrl, provider:"pollinations", seed, key, fast: !!fast });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"server_error", details: String(e).slice(0,400) });
  }
}
