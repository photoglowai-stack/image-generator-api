const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    const buffer = Buffer.from("hello world!");
    const { data, error } = await supabase.storage
      .from("photos") // ⚠️ à remplacer par ton vrai nom de bucket
      .upload(`test-${Date.now()}.txt`, buffer, { contentType: "text/plain", upsert: true });

    if (error) throw error;

    const { data: publicUrlData } = supabase.storage
      .from("photos") // idem ici
      .getPublicUrl(`test-${Date.now()}.txt`);

    return res.status(200).json({ message: "✅ Upload OK", url: publicUrlData.publicUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
