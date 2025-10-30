// api/v1/ideas/generate.mjs
import { createClient } from '@supabase/supabase-js'
import { generateWithPollinations } from '../../lib/generate-pollination.mjs'

const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
const today = () => new Date().toISOString().slice(0,10) // YYYY-MM-DD

// ⚠️ côté serveur UNIQUEMENT
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { slug, prompt, width = 1024, height = 1024, model = 'flux' } = req.body || {}
  if (!slug || !prompt) return res.status(400).json({ error: 'Missing slug or prompt' })

  const safeSlug = sanitize(String(slug))
  const filePath = `generated/ideas/${safeSlug}/${today()}/${Date.now()}.jpg` // clé complète dans le bucket

  console.log(`🧾 request | ideas.generate | slug=${safeSlug}`)

  try {
    // 1) génération provider
    const buffer = await generateWithPollinations({ prompt, width, height, model })
    console.log('🧪 provider.call | ok')

    // 2) upload storage
    // NB: le .from('<bucket>') prend le nom du bucket, la "clé" inclut ici "generated/..."
    // Si ton bucket s’appelle déjà "generated", retire le préfixe "generated/" du filePath ci-dessus.
    const BUCKET = 'generated'             // ← adapte si ton bucket a un autre nom
    const KEY = `ideas/${safeSlug}/${today()}/${Date.now()}.jpg` // clé dans le bucket

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(KEY, buffer, { contentType: 'image/jpeg', upsert: true })

    if (upErr) {
      console.error('❌ upload', upErr)
      throw upErr
    }

    // URL publique (si bucket public)
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(KEY)
    let imageUrl = pub?.publicUrl

    // (Si bucket privé → utilise createSignedUrl)
    // const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(KEY, 60*60*24*30)
    // let imageUrl = signed?.signedUrl

    console.log(`📦 stored | ${imageUrl}`)

    // 3) DB insert
    const { error: dbErr } = await supabase.from('ideas_examples').insert({
      slug: safeSlug,
      image_url: imageUrl,
      provider: 'pollinations',
      created_at: new Date().toISOString()
    })
    if (dbErr) {
      console.error('❌ db.insert', dbErr)
      throw dbErr
    }

    console.log('✅ succeeded | ideas.generate')
    return res.status(200).json({ success: true, slug: safeSlug, image_url: imageUrl })
  } catch (e) {
    console.error('❌ failed | ideas.generate', e)
    return res.status(500).json({ success: false, error: e?.message || 'Unexpected error' })
  }
}
