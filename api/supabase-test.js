// /api/supabase-test.js
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    // Test 1 : lecture des 5 dernières images
    const { data: photos, error } = await supabase
      .from("photos_meta")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) throw error;

    return res.status(200).json({
      message: "✅ Supabase connection OK",
      count: photos.length,
      lastEntries: photos,
    });
  } catch (e) {
    console.error("Supabase test error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
