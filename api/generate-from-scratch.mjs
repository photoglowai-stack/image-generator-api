// /api/generate-from-scratch.mjs
// TEXT2IMG (Flux 1.1 Pro) — sécurisé (Bearer token), CORS, débit crédits, re-upload Supabase.
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // durcis plus tard (ex: https://www.figma.com)
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const VALID_AR = new Set(["1:1","16:9","9:16","4:3","3:4","3:2","2:3","4:5","5:4","21:9","9:21","2:1","1:2"]);
const TEXT2IMG_MODEL = process.env.TEXT2IMG_MODEL || "black-forest-labs/flux-1.1-pro";

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET")   return res.status(200).json({ ok: true, endpoint: "text2img" });
  if (req.method !== "POST")  return res.status(405).json({ error: "Method not allowed" });

  // --- Auth: token Supabase obligatoire ---
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "missing_bearer_token" });

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return res.status(401).json({ success: false, error: "invalid_token" });
  const user_id = userData.user.id; // UUID

  // --- Payload ---
  const {
    prompt,
    category = "ai-headshots",
    aspect_ratio = "1:1",
    source = "figma-text2img",
    num_outputs = 1,
    negative_prompt,
    seed,
    test_mode = false
  } = req.body || {};

  if (!prompt || !VALID_AR.has(aspect_ratio)) {
    return res.status(400).json({ success: false, error: "Invalid prompt or aspect_ratio" });
  }

  const started = Date.now();
  console.log("🧾 /api/generate-from-scratch received:", {
    prompt: String(prompt).slice(0, 120),
    aspect_ratio, num_outputs, source
  });

  // --- Débit crédits atomique (RPC) ---
  const PRICE = 1;
  const debit = await supabase.rpc("debit_credits", { p_user_id: user_id, p_amount: PRICE });
  if (debit.error) {
    if (String(debit.error.message).includes("insufficient_credits")) {
      return res.status(402).json({ success: false, error: "insufficient_credits" });
    }
    return res.status(500).json({ success: false, error: debit.error.message });
  }

  try {
    // --- Appel Replicate (TEXT2IMG) ---
    const input = {
      prompt,
      aspect_ratio,
      output_format: "jpg",
      num_outputs,
      ...(negative_prompt ? { negative_prompt } : {}),
      ...(Number.isInteger(seed) ? { seed } : {})
    };
    console.log("🧪 Calling Replicate:", { model: TEXT2IMG_MODEL, input: { ...input, prompt: input.prompt.slice(0, 60) + "..." } });

    const out = await replicate.run(`${TEXT2IMG_MODEL}:latest`, { input });
    const urls = Array.isArray(out) ? out : (out?.output || out?.urls || []);
    if (!urls?.length) throw new Error("No output from model");

    // --- Re-upload outputs → Supabase (photos/outputs/...) ---
    const uploaded = [];
    for (const u of urls) {
      const r = await fetch(u);
      const buf = Buffer.from(await r.arrayBuffer());
      const path = `outputs/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.jpg`;
      const { error: upErr } = await supabase.storage.from("photos").upload(path, buf, {
        contentType: "image/jpeg", cacheControl: "31536000", upsert: false
      });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("photos").getPublicUrl(path);
      uploaded.push(pub.publicUrl);
    }

    // --- Métadonnées ---
    const duration_ms = Date.now() - started;
    await supabase.from("photos_meta").insert({
      image_url: uploaded[0],
      prompt,
      category,
      source,
      mode: "text2img",
      duration_ms,
      user_id
    });

    return res.status(200).json({
      success: true,
      mode: "text2img",
      model: TEXT2IMG_MODEL,
      image_url: uploaded[0],
      images: uploaded,
      duration_ms
    });
  } catch (e) {
    // Recrédit si la génération échoue
    await supabase.rpc("credit_credits", { p_user_id: user_id, p_amount: PRICE }).catch(() => {});
    console.error("❌ text2img error:", e?.message || e);
    return res.status(500).json({ success: false, error: e?.message || "internal_error" });
  }
}
