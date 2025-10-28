// /api/presets.js
// Lecture READ-ONLY des catégories + presets
import { ensureSupabaseClient, getSupabaseAnon } from "../lib/supabase.mjs";

const supabase = getSupabaseAnon();

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    if (!supabase) return res.status(500).json({ error: "missing_env_supabase" });
    ensureSupabaseClient(supabase, "anon");

    const { data: cats, error: e1 } = await supabase
      .from("categories")
      .select("slug,name,default_aspect_ratio,default_model,active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (e1) return res.status(500).json({ error: e1.message });

    const { data: presets, error: e2 } = await supabase
      .from("prompt_presets")
      .select("id,category_slug,name,prompt,weight")
      .order("weight", { ascending: true });

    if (e2) return res.status(500).json({ error: e2.message });

    return res.status(200).json({ success: true, categories: cats || [], presets: presets || [] });
  } catch (e) {
    console.error("❌ /api/presets error:", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
}
