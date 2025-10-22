// /api/generate.mjs
// IMG2IMG (Flux-Kontext-Pro) — Bearer token (Supabase Auth), CORS, débit crédits (RPC), re-upload Supabase, insert photos_meta.

import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

// --- CORS (durcir FRONT_ORIGIN en prod) ---
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONT_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
}

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BUCKET = process.env.BUCKET_IMAGES || "photos";
const MODEL_IMG2IMG = process.env.MODEL_IMG2IMG || "black-forest-labs/flux-kontext-pro";

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, endpoint: "img2img" });
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method_not_allowed" });

  // --- Auth: Bearer token de Supabase (coté client: supabase.auth.getSession().data.session.access_token) ---
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return res.status(401).json({ success: false, error: "invalid_token" });
  const user_id = userData.user.id;

  // --- Payload ---
  const {
    input_image,                  // URL publique http(s) (Supabase Storage → photos/uploads/...)
    prompt,
    category = "ai-headshots",
    source = "figma-img2img",
    aspect_ratio = "match_input_image", // on passe l'image, donc on peut ignorer l'AR côté modèle
    num_outputs = 1,
    negative_prompt,
    prompt_strength,              // optionnel: 0..1
    test_mode = false
  } = req.body || {};

  if (!input_image || !/^https?:\/\//.test(String(input_image)) || !prompt) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "input_image (URL) et prompt requis" }
    });
  }

  const started = Date.now();
  console.log("🧾 /api/generate received:", {
    user_id, input_image: String(input_image).slice(0, 80), prompt: String(prompt).slice(0, 80)
  });

  // --- Débit de crédits (atomique via RPC) ---
  const PRICE = 1; // 1 crédit par génération (adapter au besoin)
  const debit = await supabase.rpc("debit_credits", { p_user_id: user_id, p_amount: PRICE });
  if (debit.error) {
    if (String(debit.error.message).includes("insufficient_credits")) {
      return res.status(402).json({ success: false, error: "insufficient_credits" });
    }
    return res.status(500).json({ success: false, error: debit.error.message });
  }

  try {
    // --- Appel Replicate (IMG2IMG) ---
    // NB: Flux-Kontext-Pro attend 'image' + 'prompt'; d'autres champs possibles selon version du modèle.
    const input = {
      image: input_image,
      prompt,
      output_format: "jpg",
      num_outputs,
      ...(negative_prompt ? { negative_prompt } : {}),
      ...(typeof prompt_strength === "number" ? { prompt_strength } : {})
    };

    console.log("🧪 Calling Replicate:", {
      model: MODEL_IMG2IMG, input: { ...input, prompt: String(prompt).slice(0, 60) + "..." }
    });

    const out = await replicate.run(`${MODEL_IMG2IMG}:latest`, { input });

    // Résultat: selon la version, 'out' peut être un tableau d'URLs ou un objet { output: [...] }
    const urls = Array.isArray(out) ? out : (out?.output || out?.urls || []);
    if (!urls?.length) throw new Error("No output from model");

    // --- Re-upload → Supabase Storage (outputs/YYYY-MM-DD/uuid.jpg) ---
    const isoDay = new Date().toISOString().slice(0, 10);
    const uploaded = [];

    for (const u of urls) {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`download_failed_${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const path = `outputs/${isoDay}/${crypto.randomUUID()}.jpg`;

      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, {
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: false
      });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      uploaded.push({ path, publicUrl: pub.publicUrl });
    }

    const image_url = uploaded[0].publicUrl;
    const duration_ms = Date.now() - started;

    // --- Insert meta ---
    const { error: insErr } = await supabase.from(process.env.TABLE_META || "photos_meta").insert({
      image_url,
      prompt,
      category,
      source,
      mode: "img2img",
      duration_ms,
      user_id
    });
    if (insErr) console.warn("⚠️ insert photos_meta failed:", insErr);

    console.log("📦 stored:", { image_url, duration_ms, user_id });

    return res.status(200).json({
      success: true,
      mode: "img2img",
      model: MODEL_IMG2IMG,
      image_url,
      replicate_urls: urls,
      duration_ms
    });
  } catch (err) {
    console.error("❌ generate error:", err);
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
}
