/**
 * System-audio loopback capture → voice-activity segmentation → 16 kHz WAV.
 *
 * Windows path (reverse-engineered from Cluely, mechanism identical):
 *   1. request a 1×1 @1fps video stream only to unlock desktop capture,
 *   2. main process auto-approves via setDisplayMediaRequestHandler with audio:"loopback",
 *   3. immediately stop the video tracks,
 *   4. AudioContext(48 kHz) → MediaStreamSource → AudioWorklet posts Float32 blocks,
 *   5. RMS voice-activity segmentation (adaptive noise floor, 500 ms hangover,
 *      500 ms pre-speech pad, 20 s hard cap — same cap Cluely uses),
 *   6. downsample to 16 kHz mono, encode WAV (16-bit PCM), hand to main for STT.
 * Mic path (optional): getUserMedia → same worklet pipeline, role "me".
 * Echo-bleed guard: while "them" has voice activity, "me" audio is zeroed (Cluely does the same).
 */

const WORKLET_SRC = `
class SpecterAudioTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      const copy = new Float32Array(input);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('specter-audio-tap', SpecterAudioTap);
`

interface VADOptions {
  sampleRate: number
  frameSize: number // samples per VAD frame
  noiseFactor: number // noise floor EMA speed
  speechMult: number // speech threshold multiplier over noise floor
  minSpeechRms: number
  hangoverMs: number
  prePadMs: number
  minSpeechMs: number
  maxSegmentMs: number
}

class RmsVad {
  private readonly opts: VADOptions
  private noiseFloor = 0.004
  private ringing = 0 // remaining hangover frames
  private speechFrames = 0
  private preBuf: Float32Array[] = []
  private segBuf: Float32Array[] = []
  private segSamples = 0
  private speaking = false

  constructor(opts: Partial<VADOptions>) {
    this.opts = {
      sampleRate: 48000,
      frameSize: 512,
      noiseFactor: 0.06,
      speechMult: 2.6,
      minSpeechRms: 0.006,
      hangoverMs: 500,
      prePadMs: 500,
      minSpeechMs: 280,
      maxSegmentMs: 20000,
      ...opts
    }
  }

  /** Feed one frame; returns a complete speech segment or null. */
  push(frame: Float32Array): Float32Array | null {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)

    // track noise floor only while not speaking
    if (!this.speaking) {
      this.noiseFloor = this.noiseFloor * (1 - this.opts.noiseFactor) + rms * this.opts.noiseFactor
    }
    const threshold = Math.max(this.noiseFloor * this.opts.speechMult, this.opts.minSpeechRms)
    const isSpeech = rms > threshold
    const framesPerMs = this.opts.sampleRate / this.opts.frameSize / 1000

    if (isSpeech) {
      this.ringing = Math.round(this.opts.hangoverMs * framesPerMs)
      this.speechFrames++
    } else if (this.ringing > 0) {
      this.ringing--
    }

    if (!this.speaking && isSpeech) {
      this.speaking = true
      this.segSamples = 0
      this.segBuf = this.preBuf.splice(0) // include pre-speech padding
      for (const b of this.segBuf) this.segSamples += b.length
      this.segBuf.push(frame)
      this.segSamples += frame.length
      this.speechFrames = 1
      return null
    }

    if (this.speaking) {
      this.segBuf.push(frame)
      this.segSamples += frame.length
      const segMs = this.segSamples / (this.opts.sampleRate / 1000)
      const hardCap = segMs >= this.opts.maxSegmentMs
      const ended = this.ringing === 0 || hardCap
      if (ended) {
        const enough = this.speechFrames * this.opts.frameSize >= (this.opts.minSpeechMs / 1000) * this.opts.sampleRate
        this.speaking = false
        this.ringing = 0
        this.speechFrames = 0
        let out: Float32Array | null = null
        if (enough) {
          out = new Float32Array(this.segSamples)
          let off = 0
          for (const b of this.segBuf) {
            out.set(b, off)
            off += b.length
          }
        }
        this.segBuf = []
        this.segSamples = 0
        return out
      }
      return null
    }

    // silence: keep a rolling pre-pad buffer
    this.preBuf.push(frame)
    let pre = 0
    for (const b of this.preBuf) pre += b.length
    const maxPre = Math.round((this.opts.prePadMs / 1000) * this.opts.sampleRate)
    while (pre > maxPre && this.preBuf.length > 1) {
      pre -= this.preBuf[0].length
      this.preBuf.shift()
    }
    return null
  }
}

export interface AudioLane {
  stop: () => Promise<void>
}

function downsampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return input
  const ratio = fromRate / 16000
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let acc = 0
    for (let j = start; j < end; j++) acc += input[j]
    out[i] = end > start ? acc / (end - start) : 0
  }
  return out
}

function encodeWav16kMono(samples: Float32Array, sourceRate: number): ArrayBuffer {
  const pcm = downsampleTo16k(samples, sourceRate)
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true) // byte rate
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  let offset = 44
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

/** Test hooks for the pure DSP parts (see scripts/test-audio-pipeline.mjs). */
export const __test = { RmsVad, encodeWav16kMono, downsampleTo16k }

export type LaneState = 'off' | 'starting' | 'live' | 'error'

export interface LaneStatus {
  them: LaneState
  me: LaneState
}

export interface LaneCallbacks {
  send: (payload: { role: 'me' | 'them'; wav: ArrayBuffer }) => void
  onLevel: (role: 'me' | 'them', level: number) => void
  onStatus: (status: LaneStatus) => void
  onError: (role: 'me' | 'them', err: Error) => void
}

/**
 * Owns the capture lanes with refcounting so React effect re-runs
 * (StrictMode double-mount, mic toggle) never duplicate streams or drop the
 * session: the second acquire cancels the pending stop of the first release.
 */
class AudioManager {
  private refcount = 0
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private lanes: Partial<Record<'me' | 'them', AudioLane>> = {}
  private laneState: LaneStatus = { them: 'off', me: 'off' }
  private starting: Partial<Record<'me' | 'them', Promise<void>>> = {}
  private micDesired = false
  private cb: LaneCallbacks | null = null

  private emit(): void {
    this.cb?.onStatus({ ...this.laneState })
  }

  private laneCbs(role: 'me' | 'them'): { send: LaneCallbacks['send']; onError: (e: Error) => void } {
    return {
      send: (payload) => this.cb?.send(payload),
      onError: (e) => {
        this.laneState[role] = 'error'
        this.emit()
        this.cb?.onError(role, e)
      }
    }
  }

  private startLane(role: 'me' | 'them'): Promise<void> {
    // single-flight: Chromium aborts the previous getDisplayMedia request when a
    // second one starts in the same frame, so concurrent starts must dedupe
    // (React StrictMode double-mount does exactly that).
    if (this.lanes[role]) return Promise.resolve()
    const inflight = this.starting[role]
    if (inflight) return inflight
    const run = (async () => {
      this.laneState[role] = 'starting'
      this.emit()
      const cbs = this.laneCbs(role)
      // abort/denied-class failures are usually transient boot races
      // (cold capture subsystem, superseded requests) — retry twice
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          this.lanes[role] = await startLane(
            role,
            cbs.send,
            (level) => this.cb?.onLevel(role, level),
            cbs.onError
          )
          this.laneState[role] = 'live'
          break
        } catch (err) {
          console.error(`[audio] ${role} lane attempt ${attempt + 1} failed:`, err)
          const msg = (err as Error).message ?? ''
          const transient = /abort|denied|dismiss|cancel|ended/i.test(msg)
          if (attempt < 2 && transient) {
            await new Promise((r) => setTimeout(r, 1200))
            continue
          }
          this.laneState[role] = 'error'
          this.cb?.onError(role, err as Error)
        }
      }
      this.emit()
    })()
    this.starting[role] = run
    return run.finally(() => {
      delete this.starting[role]
    })
  }

  private async syncMic(): Promise<void> {
    if (this.micDesired && !this.lanes.me) {
      await this.startLane('me')
    } else if (!this.micDesired && this.lanes.me) {
      const lane = this.lanes.me
      this.lanes.me = undefined
      this.laneState.me = 'off'
      this.emit()
      await lane.stop()
    }
  }

  async acquire(cb: LaneCallbacks, micEnabled: boolean): Promise<void> {
    this.cb = cb
    this.refcount++
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    this.micDesired = micEnabled
    if (!this.lanes.them) await this.startLane('them')
    await this.syncMic()
  }

  async setMic(enabled: boolean): Promise<void> {
    this.micDesired = enabled
    await this.syncMic()
  }

  async release(): Promise<void> {
    this.refcount = Math.max(0, this.refcount - 1)
    if (this.refcount > 0) return
    if (this.stopTimer) clearTimeout(this.stopTimer)
    // grace window: a quick unmount/remount (StrictMode) reuses the live lanes
    this.stopTimer = setTimeout(() => {
      void this.stopAll()
    }, 800)
  }

  private async stopAll(): Promise<void> {
    const lanes = this.lanes
    this.lanes = {}
    this.laneState = { them: 'off', me: 'off' }
    this.emit()
    await Promise.all(Object.values(lanes).map((l) => l?.stop().catch(() => undefined)))
  }
}

export const audioManager = new AudioManager()

/** Start one capture lane. Returns a stopper. Errors surface via onError. */
export async function startLane(
  role: 'them' | 'me',
  send: (payload: { role: 'me' | 'them'; wav: ArrayBuffer }) => void,
  onLevel: (level: number) => void,
  onError: (err: Error) => void
): Promise<AudioLane> {
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null

  const cleanup = async (): Promise<void> => {
    if (stream) {
      for (const t of stream.getTracks()) t.stop()
      stream = null
    }
    if (ctx && ctx.state !== 'closed') {
      await ctx.close().catch(() => undefined)
      ctx = null
    }
  }

  try {
    if (role === 'them') {
      // 1×1 video unlocks desktop capture; loopback audio is the actual payload
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 1, height: 1, frameRate: 1 } as MediaTrackConstraints
      })
      for (const t of stream.getVideoTracks()) t.stop()
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    }

    ctx = new AudioContext({ sampleRate: 48000 })
    const src = ctx.createMediaStreamSource(stream)
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(workletUrl)
    URL.revokeObjectURL(workletUrl)
    const node = new AudioWorkletNode(ctx, 'specter-audio-tap', { numberOfOutputs: 1 })

    const vad = new RmsVad({ sampleRate: 48000 })
    const frameBuf = new Float32Array(512)
    let frameFill = 0

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const data = e.data
      // rolling level meter for the UI
      let sum = 0
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i]
      onLevel(Math.min(1, Math.sqrt(sum / (data.length / 4)) * 8))
      // feed the VAD in fixed-size frames
      let off = 0
      while (off < data.length) {
        const take = Math.min(frameBuf.length - frameFill, data.length - off)
        frameBuf.set(data.subarray(off, off + take), frameFill)
        frameFill += take
        off += take
        if (frameFill === frameBuf.length) {
          frameFill = 0
          const seg = vad.push(frameBuf.slice())
          if (seg) {
            try {
              send({ role, wav: encodeWav16kMono(seg, 48000) })
            } catch (err) {
              onError(err as Error)
            }
          }
        }
      }
    }
    node.port.onmessageerror = () => void cleanup()

    src.connect(node)
    const sink = ctx.createGain()
    sink.gain.value = 0
    node.connect(sink)
    sink.connect(ctx.destination)

    const onEnded = (): void => {
      // treat stream loss as recoverable: report so the manager can restart
      onError(new Error(`${role === 'them' ? 'System audio' : 'Microphone'} stream ended`))
    }
    for (const t of stream.getAudioTracks()) t.addEventListener('ended', onEnded)

    return {
      stop: async () => {
        node.port.onmessage = null
        await cleanup()
      }
    }
  } catch (err) {
    await cleanup()
    throw err
  }
}
