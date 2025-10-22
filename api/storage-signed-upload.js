// /api/storage-signed-upload.js
// Renvoie une URL d'upload signée pour le bucket "photos"
import { createClient } from "@supabase/supabase-js";

const supaAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ error: "filename required" });

    const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`;
    const { data, error } = await supaAdmin.storage.from("photos").createSignedUploadUrl(key);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ success: true, key, signedUrl: data.signedUrl });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "internal_error" });
  }
}
