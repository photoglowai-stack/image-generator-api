// api/v1/ideas/generate.mjs
import { createClient } from '@supabase/supabase-js'

// ---------- Utils ----------
const sanitize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
const today = () => new Date().toISOString().slice(0, 10) // YYYY-MM-DD

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, serviceKey)
}

// ---------- Pollinations (inline) ----------
const POLLINATIONS_POST = 'https://image.pollinations.ai/prompt'

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

async function safeText(res) {
  try { return await res.text() } catch { return '' }
}

async function validateAndBuffer(res) {
  if (!res.ok) {
    const txt = await safeText(res)
    throw new Error(`Provider ${res.status} ${res.statusText}${txt ? ` | ${txt.slice(0,160)}` : ''}`)
  }
  const ctype = res.headers.get('content-type') || ''
  if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype)) {
    const txt = await safeText(res)
    throw new Error(`Unexpected content-type: "${ctype}"${txt ? ` | ${txt.slice(0,160)}` : ''}`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

async function generateWithPollinations({ prompt, width = 1024, height = 1024, model = 'flux', negative, timeoutMs = 25000 }) {
  if (!prompt || typeof prompt !== 'string') throw new Error('generateWithPollinations: prompt is required')
  const maxSide = 1792
  width = Math.min(Math.max(64, Math.floor(width)), maxSide)
  height = Math.min(Math.max(64, Math.floor(height)), maxSide)

  // POST prioritaire
  try {
    const res = await fetchWithTimeout(
      POLLINATIONS_POST,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'image/jpeg,image/png;q=0.9,*/*;q=0.8',
          'User-Agent': 'Photoglow-API/ideas-generator'
        },
        body: JSON.stringify({ prompt, width, height, model, negative })
      },
      timeoutMs
    )
    return await validateAndBuffer(res)
  } catch (e) {
    console.warn('[pollinations] POST failed → fallback GET:', e?.message || e)
  }

  // Fallback GET
  const getUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}` +
    (model ? `&model=${encodeURIComponent(model)}` : '') +
    (negative ? `&negative=${encodeURIComponent(negative)}` : '')
  const res = await fetchWithTimeout(
    getUrl,
    { method: 'GET', headers: { 'Accept': 'image/jpeg,image/png;q=0.9,*/*;q=0.8', 'User-Agent': 'Photoglow-API/ideas-generator' } },
    timeoutMs
  )
  return await validateAndBuffer(res)
}

// ---------- Handler ----------
export default async function handler(req, res) {
  // CORS / preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
    return res.status(204).end()
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
  res.setHeader('Content-Type', 'application/json')

  // Sanity log pour vérifier la bonne version
  console.log('IDEAS_INLINE_V3')

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Body peut être string selon le runtime
  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { /* ignore */ }
  }

  const { slug, prompt, width = 1024, height = 1024, model = 'flux' } = body || {}
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

    // 2) Upload Storage
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(KEY, buffer, { contentType: 'image/jpeg', upsert: true })
    if (uploadError) { console.error('❌ upload', uploadError); throw uploadError }

    // 3) URL publique (ou signée si privé)
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(KEY)
    let imageUrl = pub?.publicUrl
    // Privé :
    // const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(KEY, 60*60*24*30)
    // imageUrl = signed?.signedUrl

    console.log(`📦 stored   | ${imageUrl}`)

    // 4) DB insert
    const { error: insertError } = await supabase.from('ideas_examples').insert({
      slug: safeSlug,
      image_url: imageUrl,
      provider: 'pollinations',
      created_at: new Date().toISOString()
    })
    if (insertError) { console.error('❌ db.insert', insertError); throw insertError }

    console.log('✅ succeeded | ideas.generate')
    return res.status(200).json({ success: true, slug: safeSlug, image_url: imageUrl })
  } catch (err) {
    console.error('❌ failed   | ideas.generate', err)
    return res.status(500).json({ success: false, error: String(err?.message || err) })
  }
}
