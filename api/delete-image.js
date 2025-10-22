// /api/delete-image.js
// Supprime des images par URL Supabase + efface la/les lignes photos_meta
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

// Extrait le path storage depuis l'URL publique
function pathFromPublicUrl(url) {
  const m = url.match(/\/storage\/v1\/object\/public\/generated_images\/(.+)$/);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { image_urls = [] } = req.body || {};
    if (!Array.isArray(image_urls) || image_urls.length === 0) {
      return res.status(400).json({ error: "image_urls required (array)" });
    }
    const paths = image_urls.map(pathFromPublicUrl).filter(Boolean);
    if (paths.length === 0) return res.status(400).json({ error: "no valid storage paths" });

    // Delete files
    const { error: delErr } = await supabase.storage.from("generated_images").remove(paths);
    if (delErr) return res.status(500).json({ error: delErr.message });

    // Delete DB rows
    const { error: dbErr } = await supabase.from("photos_meta").delete().in("image_url", image_urls);
    if (dbErr) return res.status(500).json({ error: dbErr.message });

    return res.status(200).json({ success: true, deleted: paths.length });
  } catch (e) {
    console.error("❌ /api/delete-image error:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
}
