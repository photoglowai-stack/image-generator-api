// /api/generate-gen4-image.js  —  ROUTER MONOFICHIER (Vercel Node)
// Gère: POST /v1/jobs, GET /v1/jobs/{id}, POST/GET /api/credits, POST /api/generate-gen4-image (legacy)

export default async function handler(req, res) {
  // --- CORS (unique pour toutes les routes) ---
  const ORIGIN = process.env.FRONT_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Admin-Token");
  if (req.method === "OPTIONS") return res.status(204).end();

  // --- Helpers basiques ---
  const json = (code, payload) => { res.status(code).setHeader("Content-Type","application/json"); res.end(JSON.stringify(payload)); };
  const nowIso = () => new Date().toISOString();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const uuid = () => (globalThis.crypto?.randomUUID?.() || require("crypto").randomUUID());
  const parseUrl = () => new URL(req.url, `http://${req.headers.host}`);
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "0.0.0.0";

  async function readBody() {
    try {
      if (req.body && typeof req.body === "object") return req.body;
      if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    } catch {}
    return await new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); }
      });
    });
  }

  // --- Imports (dynamiques pour cold start) ---
  const { createClient } = await import("@supabase/supabase-js");

  // --- Clients Supabase ---
  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const supabaseAuth  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,           { auth: { persistSession: false } });

  // --- Tiny rate-limit via table api_logs (60/min par IP et par route) ---
  async function rateLimit(routeKey, limitPerMin = 60) {
    try {
      const since = new Date(Date.now() - 60_000).toISOString();
      const { data, error } = await supabaseAdmin
        .from("api_logs")
        .select("id", { head: true, count: "exact" })
        .eq("route", routeKey)
        .eq("ip", clientIp)
        .gte("created_at", since);
      if (!error && (data?.length || 0) >= limitPerMin) return false;
      await supabaseAdmin.from("api_logs").insert({ ip: clientIp, route: routeKey });
    } catch {}
    return true;
  }

  // --- Idempotency cache (serveur) ---
  async function getIdem(key) {
    if (!key) return null;
    const { data } = await supabaseAdmin.from("idempotency_keys").select("response").eq("key", key).maybeSingle();
    return data?.response || null;
  }
  async function setIdem(key, userId, route, response) {
    if (!key) return;
    await supabaseAdmin.from("idempotency_keys").upsert({ key, user_id: userId || null, route, response });
  }

  // --- Auth utilisateur (Supabase JWT) ---
  async function getAuthUser() {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  }

  // --- Débit crédits (RPC SQL) ---
  async function debitUser({ userId, amount, context }) {
    return await supabaseAdmin.rpc("debit_credits", {
      p_user_id: userId,
      p_amount: amount,
      p_reason: "image_generation",
      p_meta: context || null
    });
  }

  // --- Réception / Routage ---
  const url = parseUrl();
  const path = url.pathname || "";
  const method = req.method;

  // ============ ROUTE: /api/credits (admin, safe) ============
  if (path === "/api/credits") {
    // Côté Figma, évite Failed to fetch (route existe, CORS OK, timeout côté Figma conseillé)
    // Gate admin simple par clé
    const ADM = process.env.ADMIN_API_KEY || "";
    if (!ADM) return json(500, { success: false, error: "missing_admin_api_key_env" });
    if ((req.headers["x-admin-token"] || "") !== ADM) return json(401, { success: false, error: "unauthorized" });

    if (method === "GET" && url.searchParams.get("health") === "1") {
      return json(200, { success: true, service: "credits", time: nowIso() });
    }
    if (method !== "POST") return json(405, { success: false, error: "method_not_allowed" });

    const body = await readBody();
    const { op, user_id, amount, reason, meta } = body || {};
    if (!user_id) return json(422, { success: false, error: "missing_user_id" });

    try {
      if (op === "balance") {
        const { data } = await supabaseAdmin.from("user_credits").select("user_id, credits, total_used, updated_at").eq("user_id", user_id).maybeSingle();
        return json(200, { success: true, action: "balance", data: data || { user_id, credits: 0 } });
      }
      if (!Number.isInteger(amount) || amount <= 0) return json(422, { success: false, error: "invalid_amount" });

      if (op === "credit") {
        // Alias SQL stable vers add_credits()
        const { data, error } = await supabaseAdmin.rpc("credit_credits", {
          p_user_id: user_id,
          p_amount: amount,
          p_reason: reason || "admin_adjust",
          p_meta: meta || { via: "api/credits" }
        });
        if (error) return json(400, { success: false, error: "credit_failed", details: error.message });
        return json(200, { success: true, action: "credit", data });
      }
      if (op === "debit") {
        const { data, error } = await supabaseAdmin.rpc("debit_credits", {
          p_user_id: user_id,
          p_amount: amount,
          p_reason: reason || "manual_debit",
          p_meta: meta || { via: "api/credits" }
        });
        if (error) return json(400, { success: false, error: "debit_failed", details: error.message });
        return json(200, { success: true, action: "debit", data });
      }
      return json(422, { success: false, error: "unsupported_op", supported: ["credit", "debit", "balance"] });
    } catch (e) {
      return json(500, { success: false, error: "server_error", details: String(e?.message || e) });
    }
  }

  // ============ ROUTES: /v1/jobs (POST) et /v1/jobs/{id} (GET) ============
  const isJobsList    = (path === "/v1/jobs");
  const isJobsById    = (/^\/v1\/jobs\/[0-9a-fA-F-]{36}$/).test(path);
  const extractJobId  = () => (isJobsById ? path.split("/").pop() : null);

  if (isJobsList && method === "POST") {
    if (!(await rateLimit("/v1/jobs"))) return json(429, { success: false, error: "rate_limit_exceeded" });

    const body = await readBody();
    const {
      mode, prompt, input_image_url, aspect_ratio,
      category, source, metadata, test_mode
    } = body || {};

    const rawTest = test_mode;
    const isTest = rawTest === true || rawTest === "true" || rawTest === 1 || rawTest === "1" || String(rawTest).toLowerCase?.() === "yes";
    const categorySafe = (category || "uncategorized").replace(/[^a-z0-9_\-\/]/gi, "_").slice(0, 64);
    const modeOk = mode === "text2img" || mode === "img2img";
    const arOk = ["1:1","16:9","9:16","4:3","3:4","3:2","2:3","4:5","5:4","21:9","9:21","2:1","1:2"].includes(aspect_ratio || "1:1");
    if (!modeOk) return json(422, { success: false, error: "invalid_mode" });
    if (!arOk) return json(422, { success: false, error: "invalid_aspect_ratio" });
    if (!isTest && !prompt) return json(400, { success: false, error: "missing_prompt" });
    if (!isTest && mode === "img2img" && !input_image_url) return json(422, { success: false, error: "missing_input_image_url" });

    // Idempotency
    const route = "/v1/jobs";
    const idemKey = req.headers["idempotency-key"] || metadata?.idempotency_key || null;
    if (idemKey) {
      const cached = await getIdem(idemKey);
      if (cached) return json(200, cached);
    }

    // Auth en prod
    let authUser = null;
    if (!isTest) {
      const user = await getAuthUser();
      if (!user?.id) return json(401, { success: false, error: "missing_or_invalid_token" });
      authUser = user;
    }

    // Crée job en DB
    const jobId = uuid();
    const provider = "replicate";
    const mText = `${process.env.REPLICATE_TEXT2IMG_OWNER}/${process.env.REPLICATE_TEXT2IMG_NAME}`;
    const mImg  = `${process.env.REPLICATE_IMG2IMG_OWNER}/${process.env.REPLICATE_IMG2IMG_NAME}`;
    const model = mode === "img2img" ? mImg : mText;

    await supabaseAdmin.from("image_jobs").insert({
      id: jobId, provider, model, status: "queued", prompt: prompt || null, input_image_url: input_image_url || null
    });

    // Débit en prod (si activé)
    const DEBIT_ENABLED = String(process.env.DEBIT_ENABLED ?? "true").toLowerCase() !== "false";
    if (!isTest && DEBIT_ENABLED) {
      const amount = Number(process.env.PRICE_PER_IMAGE || 1);
      const { error: debitErr } = await debitUser({
        userId: authUser.id,
        amount,
        context: { idempotency_key: idemKey, route, source: source || "web", aspect_ratio }
      });
      if (debitErr) {
        await supabaseAdmin.from("image_jobs").update({ status: "failed", updated_at: nowIso() }).eq("id", jobId);
        return json(402, { success: false, error: "debit_failed", details: debitErr.message });
      }
    }

    try {
      // Génération
      let finalUrl = null;
      const startedAt = Date.now();

      if (isTest) {
        // JPEG 1x1 pour validation
        const b64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhAQEBAQEA8QEA8QDxAPEA8PDw8QFREWFhURFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDQ0NDg0NDisZFRkrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrK//AABEIAKgBLAMBIgACEQEDEQH/xAAWAAEBAQAAAAAAAAAAAAAAAAAABQf/xAAaEAADAQEBAQAAAAAAAAAAAAAAARECAwQh/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC2gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/2Q==";
        const buf = Buffer.from(b64, "base64");
        const pathOut = templatedPath(process.env.PATH_OUTPUTS_TEMPLATE || "outputs/{YYYY-MM-DD}/{UUID}.{EXT}", { ext: "jpg" });
        const { data: up, error: upErr } = await supabaseAdmin.storage.from(process.env.BUCKET_IMAGES).upload(pathOut, buf, { contentType: "image/jpeg", upsert: true });
        if (upErr) throw upErr;
        finalUrl = supabaseAdmin.storage.from(process.env.BUCKET_IMAGES).getPublicUrl(pathOut).data.publicUrl;

        await supabaseAdmin.from("photos_meta").insert({
          image_url: finalUrl, prompt: prompt || "[test_mode]", mode, category: categorySafe, source: source || "figma",
          duration_ms: Date.now() - startedAt, user_id: authUser?.id || null
        });
        await supabaseAdmin.from("image_jobs").update({ status: "succeeded", result_url: finalUrl, updated_at: nowIso() }).eq("id", jobId);

        const response = { success: true, job_id: jobId, provider, model, status: "succeeded", image_url: finalUrl, mode: "test" };
        if (idemKey) await setIdem(idemKey, authUser?.id, route, response);
        return json(200, response);
      }

      // Prod : Replicate
      if (!process.env.REPLICATE_API_TOKEN) return json(500, { success: false, error: "replicate_token_missing" });

      await supabaseAdmin.from("image_jobs").update({ status: "running", updated_at: nowIso() }).eq("id", jobId);
      const imageUrl = await callReplicate({
        token: process.env.REPLICATE_API_TOKEN,
        mode,
        prompt,
        input_image_url,
        aspect_ratio,
        modelVersions: {
          text2img: process.env.REPLICATE_TEXT2IMG_VERSION,
          img2img: process.env.REPLICATE_IMG2IMG_VERSION
        }
      });

      // Re-host dans Supabase Storage
      const pathOut = templatedPath(process.env.PATH_OUTPUTS_TEMPLATE || "outputs/{YYYY-MM-DD}/{UUID}.{EXT}", { ext: "jpg" });
      const fetched = await fetch(imageUrl);
      if (!fetched.ok) throw new Error(`download_failed_${fetched.status}`);
      const arrayBuf = await fetched.arrayBuffer();
      const { error: upErr2 } = await supabaseAdmin.storage.from(process.env.BUCKET_IMAGES).upload(pathOut, Buffer.from(arrayBuf), { contentType: "image/jpeg", upsert: true });
      if (upErr2) throw upErr2;
      finalUrl = supabaseAdmin.storage.from(process.env.BUCKET_IMAGES).getPublicUrl(pathOut).data.publicUrl;

      await supabaseAdmin.from("photos_meta").insert({
        image_url: finalUrl, prompt, mode, category: categorySafe, source: source || "web",
        duration_ms: Date.now() - startedAt, user_id: authUser?.id || null
      });
      await supabaseAdmin.from("image_jobs").update({ status: "succeeded", result_url: finalUrl, updated_at: nowIso() }).eq("id", jobId);

      const response = { success: true, job_id: jobId, provider, model, status: "succeeded", image_url: finalUrl };
      if (idemKey) await setIdem(idemKey, authUser?.id, route, response);
      return json(200, response);

    } catch (e) {
      await supabaseAdmin.from("image_jobs").update({ status: "failed", updated_at: nowIso() }).eq("id", jobId);
      return json(502, { success: false, error: "generation_failed", details: String(e?.message || e) });
    }
  }

  if (isJobsById && method === "GET") {
    const jobId = extractJobId();
    const { data, error } = await supabaseAdmin.from("image_jobs").select("id,status,result_url").eq("id", jobId).maybeSingle();
    if (error || !data) return json(404, { success: false, error: "job_not_found" });
    return json(200, { success: true, job_id: data.id, status: data.status, image_url: data.result_url || null });
  }

  // ============ ROUTE LEGACY: /api/generate-gen4-image (compat Figma) ============
  if (path === "/api/generate-gen4-image" && method === "POST") {
    // On mappe vers /v1/jobs pour garder l’ancien plugin compatible
    const body = await readBody();
    const payload = {
      mode: body?.input_image_url ? "img2img" : "text2img",
      prompt: body?.prompt,
      input_image_url: body?.input_image_url,
      aspect_ratio: body?.aspect_ratio || "1:1",
      category: body?.category || "uncategorized",
      source: body?.source || "figma",
      metadata: body?.metadata || {},
      test_mode: body?.test_mode === true || body?.test_mode === "true"
    };
    // Simule un appel interne à /v1/jobs
    req.headers["idempotency-key"] = req.headers["idempotency-key"] || body?.metadata?.idempotency_key || null;
    req.method = "POST";
    req.url = "/v1/jobs";
    // On relance le handler (très simple) : on passe par la branche /v1/jobs
    return handler(req, res);
  }

  // Fallback
  return json(404, { success: false, error: "route_not_found", path, method });

  // --- Helpers locaux ---
  function templatedPath(tpl, { ext }) {
    const d = new Date();
    const yyyy_mm_dd = d.toISOString().slice(0,10);
    return tpl.replace("{YYYY-MM-DD}", yyyy_mm_dd).replace("{UUID}", uuid()).replace("{EXT}", ext || "jpg");
  }

  async function callReplicate({ token, mode, prompt, input_image_url, aspect_ratio, modelVersions }) {
    const endpoint = "https://api.replicate.com/v1/predictions";
    const headers = { "Content-Type": "application/json", "Authorization": `Token ${token}` };
    const version = mode === "img2img" ? modelVersions.img2img : modelVersions.text2img;
    const input = mode === "img2img"
      ? { prompt, image: input_image_url, aspect_ratio }
      : { prompt, aspect_ratio };

    const create = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ version, input }) });
    if (!create.ok) throw new Error(`replicate_create_${create.status}`);
    const pred = await create.json();

    const started = Date.now();
    while (true) {
      const r = await fetch(`${endpoint}/${pred.id}`, { headers });
      if (!r.ok) throw new Error(`replicate_poll_${r.status}`);
      const data = await r.json();
      if (data.status === "succeeded") {
        const out = Array.isArray(data.output) ? data.output[0] : (data.output?.[0] || data.output);
        if (!out) throw new Error("replicate_no_output");
        return out;
      }
      if (data.status === "failed" || data.status === "canceled") throw new Error(`replicate_${data.status}`);
      if (Date.now() - started > 50_000) throw new Error("replicate_timeout");
      await sleep(2000);
    }
  }
}
