// lib/generate-pollination.mjs
// Wrapper robuste pour Pollinations : POST prioritaire, fallback GET, timeout, validations.

const POLLINATIONS_POST = 'https://image.pollinations.ai/prompt'

/**
 * Génère une image et renvoie un Buffer prêt à uploader (JPEG recommandé).
 * @param {Object} opts
 * @param {string} opts.prompt              - Prompt texte
 * @param {number} [opts.width=1024]        - Largeur en px
 * @param {number} [opts.height=1024]       - Hauteur en px
 * @param {string} [opts.model='flux']      - Modèle (ex: 'flux')
 * @param {string} [opts.negative]          - Negative prompt optionnel
 * @param {number} [opts.timeoutMs=25000]   - Timeout total par tentative
 * @returns {Promise<Buffer>}
 */
export async function generateWithPollinations({
  prompt,
  width = 1024,
  height = 1024,
  model = 'flux',
  negative,
  timeoutMs = 25000,
}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('generateWithPollinations: prompt is required')
  }

  // Petit garde-fou taille (évite images énormes par erreur)
  const maxSide = 1792
  width = Math.min(Math.max(64, Math.floor(width)), maxSide)
  height = Math.min(Math.max(64, Math.floor(height)), maxSide)

  // --- Tentative POST (binaire direct)
  try {
    const buffer = await fetchWithTimeout(
      POLLINATIONS_POST,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'image/jpeg,image/png;q=0.9,*/*;q=0.8',
          'User-Agent': 'Photoglow-API/ideas-generator',
        },
        body: JSON.stringify({ prompt, width, height, model, negative }),
      },
      timeoutMs
    ).then(validateAndBuffer)
    return buffer
  } catch (e) {
    // On log à l’appelant ; on tombera en fallback GET ensuite
    console.warn('[pollinations] POST failed → fallback GET:', e?.message || e)
  }

  // --- Fallback GET (certains endpoints Pollinations servent l’image via GET)
  const getUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}` +
    (model ? `&model=${encodeURIComponent(model)}` : '') +
    (negative ? `&negative=${encodeURIComponent(negative)}` : '')

  const buffer = await fetchWithTimeout(
    getUrl,
    {
      method: 'GET',
      headers: {
        'Accept': 'image/jpeg,image/png;q=0.9,*/*;q=0.8',
        'User-Agent': 'Photoglow-API/ideas-generator',
      },
    },
    timeoutMs
  ).then(validateAndBuffer)

  return buffer
}

/* -------------------- Helpers -------------------- */

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return res
  } finally {
    clearTimeout(tid)
  }
}

async function validateAndBuffer(res) {
  if (!res.ok) {
    const txt = await safeText(res)
    throw new Error(`Provider ${res.status} ${res.statusText}${txt ? ` | ${txt.slice(0,160)}` : ''}`)
  }

  // Vérification sommaire du type (Pollinations renvoie normalement une image)
  const ctype = res.headers.get('content-type') || ''
  if (!/image\/(jpeg|jpg|png|webp)/i.test(ctype)) {
    const txt = await safeText(res)
    throw new Error(`Unexpected content-type: "${ctype}"${txt ? ` | ${txt.slice(0,160)}` : ''}`)
  }

  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
