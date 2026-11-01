// Functional test for the local VAD + WAV pipeline (pure DSP parts of audio.ts).
// Feeds synthetic audio: 1 s near-silence → 1 s of loud 440 Hz tone → 1 s silence.
// Expects exactly one speech segment encoded as a 16 kHz mono WAV.
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'

const tmp = 'node_modules/.tmp-test'
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
execSync(
  `npx esbuild src/renderer/overlay/audio.ts --bundle --platform=node --format=cjs --outfile=${tmp}/audio.cjs --log-level=error`,
  { stdio: 'inherit' }
)

const require = createRequire(import.meta.url)
// startLane touches browser globals only when invoked; the pure DSP exports are what we need.
const mod = require(process.cwd() + '/' + tmp + '/audio.cjs')

// RmsVad isn't exported directly; exercise it through a tiny re-implementation? No —
// export it for tests instead of re-implementing here.
if (!mod.__test) {
  console.error('TEST_SETUP_FAIL: no test hooks exported')
  process.exit(2)
}

const { RmsVad, encodeWav16kMono } = mod.__test
const SR = 48000

// build frames of 512 samples
function frameOf(fill) {
  const f = new Float32Array(512)
  if (fill) fill(f)
  return f
}

const vad = new RmsVad({ sampleRate: SR })
const segments = []

// 1 s silence (quiet noise floor)
for (let i = 0; i < Math.floor(SR / 512); i++) {
  const seg = vad.push(frameOf((f) => f.forEach((_, j) => (f[j] = (Math.random() - 0.5) * 0.0008))))
  if (seg) segments.push(seg)
}
// 1 s loud tone
let phase = 0
for (let i = 0; i < Math.floor(SR / 512); i++) {
  const seg = vad.push(
    frameOf((f) =>
      f.forEach((_, j) => {
        phase += (2 * Math.PI * 440) / SR
        f[j] = 0.3 * Math.sin(phase)
      })
    )
  )
  if (seg) segments.push(seg)
}
// 1 s silence → segment should end here
for (let i = 0; i < Math.floor(SR / 512) + 60; i++) {
  const seg = vad.push(frameOf((f) => f.forEach((_, j) => (f[j] = (Math.random() - 0.5) * 0.0008))))
  if (seg) segments.push(seg)
}

console.log('SEGMENTS', segments.length)
let ok = true
if (segments.length !== 1) {
  ok = false
  console.error('FAIL: expected exactly 1 speech segment')
} else {
  const wav = encodeWav16kMono(segments[0], SR)
  const v = new DataView(wav)
  const riff = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))
  const wave = String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11))
  const rate = v.getUint32(24, true)
  const channels = v.getUint16(22, true)
  const bits = v.getUint16(34, true)
  const dataLen = v.getUint32(40, true)
  const durationMs = Math.round((dataLen / 2 / 16000) * 1000)
  console.log('WAV', { riff, wave, rate, channels, bits, durationMs })
  const checks = [
    [riff === 'RIFF', 'RIFF header'],
    [wave === 'WAVE', 'WAVE header'],
    [rate === 16000, '16 kHz sample rate'],
    [channels === 1, 'mono'],
    [bits === 16, '16-bit PCM'],
    [durationMs > 800 && durationMs < 2300, `sane duration (${durationMs} ms)`]
  ]
  for (const [pass, label] of checks) {
    console.log((pass ? '  ✓ ' : '  ✗ ') + label)
    if (!pass) ok = false
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(ok ? 'AUDIO_TEST_OK' : 'AUDIO_TEST_FAIL')
process.exit(ok ? 0 : 1)
