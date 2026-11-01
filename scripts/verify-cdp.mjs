// Runtime verification: attaches to the overlay's CDP endpoint, collects console
// errors / exceptions, and checks the UI rendered. Usage:
//   node scripts/verify-cdp.mjs [port] [seconds]
import { get } from 'node:http'

const port = process.argv[2] ?? '9333'
const seconds = Number(process.argv[3] ?? 4)

const targets = await new Promise((resolve, reject) => {
  get(`http://127.0.0.1:${port}/json/list`, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => resolve(JSON.parse(d)))
  }).on('error', reject)
})

const page = targets.find((t) => t.type === 'page' && t.url.includes('overlay'))
if (!page) {
  console.error('VERIFY_FAIL: no overlay page target found. Targets:', targets.map((t) => t.url))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let seq = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

const problems = []
let sawPill = false
let sawRoot = false
let consoleCount = 0

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    consoleCount++
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    problems.push(`console.${msg.params.type}: ${text.slice(0, 300)}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    problems.push(`exception: ${(d.exception?.description ?? d.text ?? '').slice(0, 300)}`)
  }
}

await send('Runtime.enable')
await send('Runtime.runIfWaitingForDebugger').catch(() => undefined)

// let any early errors surface
await new Promise((r) => setTimeout(r, seconds * 1000))

const root = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    hasPill: !!document.querySelector('.pill'),
    hasPanel: !!document.querySelector('.panel'),
    pillStatus: document.querySelector('.pill-status')?.textContent ?? null,
    bodySize: [document.body.clientWidth, document.body.clientHeight]
  })`,
  returnByValue: true
})
const state = JSON.parse(root.result.value)
sawRoot = state.rootChildren > 0
sawPill = state.hasPill

console.log('OVERLAY_STATE', JSON.stringify(state))
console.log('CONSOLE_PROBLEMS', problems.length)
for (const p of problems) console.log('  -', p)

ws.close()
const ok = sawRoot && problems.length === 0
console.log(ok ? 'VERIFY_OK' : 'VERIFY_FAIL')
process.exit(ok ? 0 : 1)
