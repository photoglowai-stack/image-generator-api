// api/v1/ideas/generate.mjs
import { createClient } from '@supabase/supabase-js'
import { generateWithPollinations } from '../../lib/generate-pollination.mjs'

// --- Utils
const sanitize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
const today = () => new Date().toISOString().slice(0, 10) // YYYY-MM-DD

// Crée le client Supabase seulement après avoir validé les envs
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, serviceKey)
}

export default async function handler(req, res) {
  // --- CORS / preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
    return res.status(204).end()
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
  res.setHeader('Content-Type', 'application/json')

  // --- Méthode
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // --- Body (string ou objet selon runtime)
  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { /* ignore */ }
  }

  const {
    slug,
    prompt,
    width = 1024,
    height = 1024,
    model = 'flux'
  } = body || {}

  if (!slug || !prompt) {
    return res.status(400).json({ error: 'Missing slug or prompt' })
  }

  const safeSlug = sanitize(slug)
  const BUCKET = 'generated' // ← remplace si ton bucket a un autre nom
  const now = Date.now()
  const KEY = `ideas/${safeSlug}/${today()}/${now}.jpg`

  console.log(`🧾 request  | ideas.generate | slug=${safeSlug}`)

  try {
    const supabase = getSupabase()

    // 1) Génération provider
    const buffer = await generateWithPollinations({ prompt, width, height, model })
    console.log('🧪 provider.call | ok')

    // 2) Upload Storage (clé = KEY, bucket = BUCKET)
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(KEY, buffer, { contentType: 'image/jpeg', upsert: true })
    if (uploadError) {
      console.error('❌ upload', uploadError)
      throw uploadError
    }

    // 3) URL publique (si bucket public)
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(KEY)
    let imageUrl = pub?.publicUrl

    // (Si bucket privé → décommente)
    // const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(KEY, 60 * 60 * 24 * 30)
    // imageUrl = signed?.signedUrl

    console.log(`📦 stored   | ${imageUrl}`)

    // 4) DB insert
    const { error: insertError } = await supabase.from('ideas_examples').insert({
      slug: safeSlug,
      image_url: imageUrl,
      provider: 'pollinations',
      created_at: new Date().toISOString()
    })
    if (insertError) {
      console.error('❌ db.insert', insertError)
      throw insertError
    }

    console.log('✅ succeeded | ideas.generate')
    return res.status(200).json({ success: true, slug: safeSlug, image_url: imageUrl })
  } catch (err) {
    console.error('❌ failed   | ideas.generate', err)
    return res.status(500).json({ success: false, error: String(err?.message || err) })
  }
}
