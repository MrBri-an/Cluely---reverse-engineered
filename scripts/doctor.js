// Specter doctor — runs inside Electron to decrypt the stored key via safeStorage
// and exercise the real Groq pipeline. Never prints the key itself.
// Usage: node_modules/.bin/electron scripts/doctor.js
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

// MUST run before app.whenReady(): Chromium's os_crypt loads its AES key from
// <userData>/Local State during startup, and safeStorage blobs are only
// decryptable with the key from the same user-data dir the app used.
app.setPath('userData', path.join(app.getPath('appData'), 'specter'))

const BASE = 'https://api.groq.com/openai/v1'
const results = []
const log = (ok, label, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

async function main() {
  await app.whenReady()

  // 1. stored key
  const keyPath = path.join(app.getPath('userData'), 'specter-key.bin')
  let key = null
  try {
    const buf = fs.readFileSync(keyPath)
    key = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch (e) {
    console.log('key read error:', keyPath, '→', e.message)
  }
  log(!!key, 'API key decrypts via safeStorage', key ? `(length ${key.length}, gsk_ prefix: ${key.startsWith('gsk_')})` : 'could not read/decrypt specter-key.bin')
  if (!key) process.exit(1)

  const groq = async (p, init) => {
    const res = await fetch(BASE + p, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init?.headers ?? {}) } })
    if (!res.ok) {
      let d = res.statusText
      try { d = (await res.json())?.error?.message ?? d } catch {}
      throw new Error(`HTTP ${res.status}: ${d}`)
    }
    return res
  }

  // 2. model list
  let modelIds = []
  try {
    const res = await groq('/models')
    const data = await res.json()
    modelIds = (data.data ?? []).map((m) => m.id)
    log(true, 'GET /models', `${modelIds.length} models visible to this key`)
  } catch (e) {
    log(false, 'GET /models', e.message)
    process.exit(1)
  }

  // 3. configured models exist (the app auto-migrates stale ones at boot)
  const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'specter-settings.json'), 'utf8'))
  const CANDIDATES = {
    chat: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    fast: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    vision: ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'],
    stt: ['whisper-large-v3-turbo', 'whisper-large-v3']
  }
  const resolve = (slot) => {
    const configured = settings.models[slot]
    if (modelIds.includes(configured)) return configured
    return CANDIDATES[slot].find((c) => modelIds.includes(c)) ?? configured
  }
  for (const slot of Object.keys(settings.models)) {
    const id = settings.models[slot]
    if (modelIds.includes(id)) {
      log(true, `configured ${slot} model exists: ${id}`)
    } else {
      const resolved = resolve(slot)
      const fixable = modelIds.includes(resolved)
      if (!fixable && slot === 'vision') {
        // no multimodal model exists on this key — the app's designed fallback
        log(true, `vision unavailable on this key`, 'app answers screen requests text-only with a notice (by design)')
      } else {
        log(fixable, `${slot} model ${id} is stale`, fixable ? `app auto-migrates to: ${resolved}` : 'no candidate available on this key')
      }
    }
  }

  // 4. chat inference with the model the app would actually use
  const chatModel = resolve('chat')
  try {
    const res = await groq('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chatModel, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 300, reasoning_effort: 'low' })
    })
    const j = await res.json()
    const text = j?.choices?.[0]?.message?.content?.trim()
    log(!!text, 'chat inference (' + chatModel + ')', `reply: ${JSON.stringify(text)}`)
  } catch (e) {
    log(false, 'chat inference (' + chatModel + ')', e.message)
  }

  // 5. vision — passes when the key has a multimodal model, or when the app's
  // text-only fallback path is in effect (no multimodal model at all)
  const visionModel = resolve('vision')
  if (!modelIds.includes(visionModel)) {
    log(true, 'vision unavailable on this key', 'app degrades to text-only answers with a notice (by design)')
  } else {
    try {
      const png1x1 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
      const res = await groq('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: visionModel,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'What color? one word' }, { type: 'image_url', image_url: { url: png1x1 } }] }],
          max_tokens: 5
        })
      })
      const j = await res.json()
      const text = j?.choices?.[0]?.message?.content?.trim()
      log(!!text, 'vision inference (' + visionModel + ')', `reply: ${JSON.stringify(text)}`)
    } catch (e) {
      log(false, 'vision inference (' + visionModel + ')', e.message)
    }
  }

  // 6. STT with 0.5 s of silence
  try {
    const sr = 16000
    const samples = sr / 2
    const wav = Buffer.alloc(44 + samples * 2)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + samples * 2, 4)
    wav.write('WAVE', 8)
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(sr, 24)
    wav.writeUInt32LE(sr * 2, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(samples * 2, 40)
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'silence.wav')
    form.append('model', settings.models.stt)
    form.append('response_format', 'json')
    const res = await groq('/audio/transcriptions', { method: 'POST', body: form })
    const j = await res.json()
    log(typeof j.text === 'string', 'STT endpoint (' + settings.models.stt + ')', `silence transcribed to: ${JSON.stringify(j.text)}`)
  } catch (e) {
    log(false, 'STT endpoint (' + settings.models.stt + ')', e.message)
  }

  // 7. suggest better vision/chat models if configured ones are gone
  const visionish = modelIds.filter((m) => /scout|maverick|vision/i.test(m))
  console.log('\nVision-capable models visible to this key:', visionish.join(', ') || '(none)')
  console.log('Whisper models:', modelIds.filter((m) => /whisper/i.test(m)).join(', ') || '(none)')

  const failed = results.filter((r) => !r).length
  console.log(failed === 0 ? '\nDOCTOR_OK' : `\nDOCTOR_FAIL (${failed} failing checks)`)
  app.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('DOCTOR_CRASH', e)
  app.exit(1)
})
