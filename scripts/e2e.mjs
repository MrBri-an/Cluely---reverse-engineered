// End-to-end runtime test inside the live overlay:
//  1. waits for boot, checks console errors
//  2. starts the audio lane path (session) and reports lane state
//  3. runs a real streaming ask through the stored Groq key
// Usage: node scripts/e2e.mjs [cdpPort]
import { get } from 'node:http'

const port = process.argv[2] ?? '9333'

const targets = await new Promise((resolve, reject) => {
  get(`http://127.0.0.1:${port}/json/list`, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => resolve(JSON.parse(d)))
  }).on('error', reject)
})

const page = targets.find((t) => t.type === 'page' && t.url.includes('overlay'))
if (!page) {
  console.error('E2E_FAIL: no overlay target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let seq = 0
const pending = new Map()
const events = []
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    events.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    events.push('exception: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text ?? '').slice(0, 200))
  }
}

await send('Runtime.enable')

// settle: settings load + audio lane startup
await new Promise((r) => setTimeout(r, 2500))

// 1. UI state
const ui = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    pillStatus: document.querySelector('.pill-status')?.textContent ?? null,
    hasPill: !!document.querySelector('.pill'),
    orbLive: !!document.querySelector('.orb-live'),
    pillErr: !!document.querySelector('.pill-err')
  })`,
  returnByValue: true
})
console.log('UI', ui.result.value)

// 2. session + lane state via the app API
const state1 = await send('Runtime.evaluate', {
  expression: `window.specter.getSession().then(r => JSON.stringify({ session: !!r.session, transcript: r.transcript.length }))`,
  returnByValue: true,
  awaitPromise: true
})
console.log('SESSION_BEFORE', state1.result.value)

// evaluate the ask inside the page (the promise above runs in node scope, so redo in-page)
const askInPage = await send('Runtime.evaluate', {
  expression: `(async () => {
    return await new Promise((resolve) => {
      let text = '', notice = '', errored = null, done = false
      const timeout = setTimeout(() => { if (!done) resolve({ text, notice, errored: errored || 'timeout' }) }, 45000)
      const un = window.specter.onAskEvent((e) => {
        if (e.type === 'delta') text += e.text ?? ''
        if (e.type === 'notice') notice = e.text ?? ''
        if (e.type === 'error') errored = e.text ?? 'error'
        if (e.type === 'done' && !done) { done = true; clearTimeout(timeout); un(); resolve({ text, notice, errored }) }
      })
      window.specter.ask({ prompt: 'In one short sentence, say hello and confirm you are working.', mode: 'assist', includeScreen: false, includeTranscript: false }).catch((err) => { done = true; clearTimeout(timeout); resolve({ text: '', notice, errored: String(err) }) })
    })
  })()`,
  returnByValue: true,
  awaitPromise: true
})
console.log('ASK', askInPage.result.value)

const session2 = await send('Runtime.evaluate', {
  expression: `window.specter.getSession().then(r => JSON.stringify({ session: !!r.session, transcript: r.transcript.length }))`,
  returnByValue: true,
  awaitPromise: true
})
console.log('SESSION_AFTER', session2.result.value)

console.log('RUNTIME_EVENTS', events.length)
for (const e of events) console.log('  -', e)

ws.close()
const ask = askInPage.result.value
const ok = !ask.errored && ask.text && ask.text.length > 5 && events.length === 0
console.log(ok ? 'E2E_OK' : 'E2E_FAIL')
process.exit(ok ? 0 : 1)
