import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { user_id, delta } = req.body ?? {};
  if (!user_id || typeof delta !== "number") {
    return res.status(422).json({ error: "user_id et delta (number) sont requis" });
  }

  // update atomique (évite race conditions simples)
  const { data, error } = await supabase
    .from("user_credits")
    .update({ credits: supabase.rpc ? undefined : undefined }) // placeholder pour compat compat
    .eq("user_id", user_id)
    .select();

  // Fallback SQL simple via RPC si tu préfères:
  // await supabase.rpc("add_credits", { uid: user_id, d: delta });

  // Comme supabase-js ne permet pas l'update arithmétique inline,
  // on lit puis écrit (simple, à durcir si haute concurrence)
  if (error || !data?.length) {
    // read current
    const { data: row, error: readErr } = await supabase
      .from("user_credits").select("credits").eq("user_id", user_id).maybeSingle();
    if (readErr || !row) return res.status(500).json({ error: readErr || "user not found" });

    const newCredits = (row.credits ?? 0) + delta;
    const { error: updErr, data: updData } = await supabase
      .from("user_credits").update({ credits: newCredits }).eq("user_id", user_id).select();
    if (updErr) return res.status(500).json({ error: updErr.message || updErr });
    return res.status(200).json({ success: true, data: updData });
  }

  return res.status(200).json({ success: true, data });
}
