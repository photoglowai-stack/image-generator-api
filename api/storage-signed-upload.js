export const config = { runtime: "nodejs" };

import { randomUUID } from "crypto";

import { setCORS } from "../lib/http.mjs";
import {
  ensureSupabaseClient,
  getSupabaseAnon,
  getSupabaseServiceRole,
} from "../lib/supabase.mjs";

const supabaseAuth = getSupabaseAnon();
const supabaseAdmin = getSupabaseServiceRole();

const BUCKET_UPLOADS = process.env.BUCKET_UPLOADS || "photos";
const UPLOAD_OBJECT_PREFIX = process.env.UPLOAD_OBJECT_PREFIX || "uploads";
const UPLOAD_SIGNED_TTL_S = Number(process.env.UPLOAD_SIGNED_TTL_S || 60 * 15);

const EXTENSION_MAP = new Map([
  ["jpeg", "jpg"],
  ["jpg", "jpg"],
  ["png", "png"],
  ["webp", "webp"],
  ["gif", "gif"],
]);

function sanitizeSegment(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferExtension({ fileExtension, contentType, filename }) {
  const fromInput = sanitizeSegment(fileExtension || "").toLowerCase();
  if (EXTENSION_MAP.has(fromInput)) return EXTENSION_MAP.get(fromInput);

  if (filename) {
    const match = String(filename).toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (match && EXTENSION_MAP.has(match[1])) return EXTENSION_MAP.get(match[1]);
  }

  if (contentType) {
    const lower = String(contentType).toLowerCase();
    if (lower.includes("png")) return "png";
    if (lower.includes("webp")) return "webp";
    if (lower.includes("gif")) return "gif";
  }

  return "jpg";
}

function buildObjectPath(userId, folder, baseName, extension) {
  const safeFolder = sanitizeSegment(folder);
  const today = new Date().toISOString().slice(0, 10);
  const segments = [
    UPLOAD_OBJECT_PREFIX,
    sanitizeSegment(userId),
    today,
  ];
  if (safeFolder) segments.push(safeFolder);
  const safeBase = sanitizeSegment(baseName || randomUUID()) || randomUUID();
  return `${segments.join("/")}/${safeBase}.${extension}`;
}

export default async function handler(req, res) {
  setCORS(req, res, {
    allowMethods: "GET,POST,OPTIONS",
    allowHeaders: "content-type, authorization, idempotency-key",
  });

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      bucket: BUCKET_UPLOADS,
      prefix: UPLOAD_OBJECT_PREFIX,
      ttl_seconds: UPLOAD_SIGNED_TTL_S,
      has_supabase_admin: !!supabaseAdmin,
      has_supabase_anon: !!supabaseAuth,
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    ensureSupabaseClient(supabaseAdmin, "service");
    ensureSupabaseClient(supabaseAuth, "anon");

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
      return res.status(401).json({ ok: false, error: "missing_bearer_token" });
    }

    const { data: userData, error: authErr } = await supabaseAuth.auth.getUser(token);
    if (authErr || !userData?.user) {
      return res.status(401).json({ ok: false, error: "invalid_token" });
    }
    const user_id = userData.user.id;

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const {
      filename,
      file_name,
      folder,
      file_extension,
      extension,
      content_type,
      contentType,
    } = body;

    const ext = inferExtension({
      fileExtension: extension || file_extension,
      contentType: contentType || content_type,
      filename: filename || file_name,
    });

    const baseName = filename || file_name || randomUUID();
    const objectPath = buildObjectPath(user_id, folder, baseName, ext);

    const storage = supabaseAdmin.storage.from(BUCKET_UPLOADS);
    const { data, error } = await storage.createSignedUploadUrl(
      objectPath,
      UPLOAD_SIGNED_TTL_S,
      {
        contentType: contentType || content_type || undefined,
      }
    );

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json({
      ok: true,
      bucket: BUCKET_UPLOADS,
      path: data?.path || objectPath,
      token: data?.token || null,
      signed_url: data?.signedUrl || null,
      expires_in: UPLOAD_SIGNED_TTL_S,
    });
  } catch (error) {
    console.error("storage-signed-upload", error);
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
}
