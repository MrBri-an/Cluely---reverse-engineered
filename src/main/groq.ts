import type { Mode, ModelInfo, Settings } from '../shared/types'

const GROQ_BASE = 'https://api.groq.com/openai/v1'

export class GroqError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.status = status
  }
}

async function groqFetch(path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${GROQ_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) }
    })
  } catch (e) {
    throw new GroqError(`Network error reaching Groq: ${(e as Error).message}`)
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body?.error?.message ?? JSON.stringify(body)
    } catch {
      /* keep statusText */
    }
    throw new GroqError(`Groq ${res.status}: ${detail}`, res.status)
  }
  return res
}

export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await groqFetch('/models', apiKey)
  const data = (await res.json()) as { data?: ModelInfo[] }
  return data.data ?? []
}

/** gpt-oss models are reasoning models: they spend tokens thinking before the
 *  visible answer, so they need a bigger budget and a low effort setting. */
function isReasoningModel(model: string): boolean {
  return /gpt-oss/i.test(model)
}

function reasoningBody(model: string, base: Record<string, unknown>): string {
  return JSON.stringify(isReasoningModel(model) ? { ...base, reasoning_effort: 'low' } : base)
}

/**
 * Streams a chat completion. Calls onDelta for every token chunk.
 * Returns the full text. Vision turns pass message content parts with image data URLs.
 */
export async function chatStream(
  apiKey: string,
  opts: {
    model: string
    messages: Array<{ role: string; content: unknown }>
    temperature?: number
    maxTokens?: number
    onDelta: (text: string) => void
    signal?: AbortSignal
  }
): Promise<string> {
  const res = await groqFetch('/chat/completions', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: reasoningBody(opts.model, {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 2048,
      stream: true
    }),
    signal: opts.signal
  })

  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const delta: string | undefined = json?.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          opts.onDelta(delta)
        }
      } catch {
        /* partial JSON line — skip */
      }
    }
  }
  return full
}

/** Non-streaming completion, used for the auto-suggest gate where we want one shot. */
export async function chatOnce(
  apiKey: string,
  opts: {
    model: string
    messages: Array<{ role: string; content: unknown }>
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }
): Promise<string> {
  const res = await groqFetch('/chat/completions', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: reasoningBody(opts.model, {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 512
    }),
    signal: opts.signal
  })
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return json.choices?.[0]?.message?.content ?? ''
}

/**
 * Transcribes a 16 kHz mono WAV buffer via Groq's OpenAI-compatible endpoint.
 */
export async function transcribeWav(
  apiKey: string,
  model: string,
  wav: ArrayBuffer,
  language?: string
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav')
  form.append('model', model)
  form.append('response_format', 'json')
  if (language && language !== 'auto') form.append('language', language)
  const res = await groqFetch('/audio/transcriptions', apiKey, { method: 'POST', body: form })
  const json = (await res.json()) as { text?: string }
  return (json.text ?? '').trim()
}

// ---------------------------------------------------------------------------
// Model resolution — Groq's catalog changes; configured IDs can disappear.
// ---------------------------------------------------------------------------

/** Ordered candidates per slot, newest-first. The first entry present in the
 *  key's /models list wins; the configured id always takes priority when valid. */
const MODEL_CANDIDATES = {
  chat: [
    'openai/gpt-oss-120b',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant'
  ],
  fast: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  vision: [
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct'
  ],
  stt: ['whisper-large-v3-turbo', 'whisper-large-v3']
} as const

export type ModelSlot = keyof typeof MODEL_CANDIDATES

/** Model IDs the stored key can actually see; kept fresh by ipc (key:set / key:validate / models:list). */
let availableModelsCache: string[] = []

export function setAvailableModels(ids: string[]): void {
  availableModelsCache = ids
}

export function getAvailableModels(): string[] {
  return availableModelsCache
}

/**
 * Picks the best available id for a slot: the configured model if the key can
 * see it, else the first candidate the key can see, else the configured id
 * (which will fail with a clear 404 — surfaced to the UI).
 */
export function resolveModel(
  slot: ModelSlot,
  configured: string,
  available: string[] = availableModelsCache
): string {
  if (!available.length || available.includes(configured)) return configured
  for (const candidate of MODEL_CANDIDATES[slot]) {
    if (available.includes(candidate)) return candidate
  }
  return configured
}

/** True when the key can see any multimodal (image-capable) model we know of. */
export function visionAvailable(available: string[]): boolean {
  return MODEL_CANDIDATES.vision.some((m) => available.includes(m))
}

/**
 * Rewrites stored settings so every slot points at a model the key can see.
 * Returns null when nothing changed.
 */
export function migrateModels(settings: Settings, available: string[]): Partial<Settings> | null {
  const next: Record<string, string> = {}
  for (const slot of Object.keys(MODEL_CANDIDATES) as ModelSlot[]) {
    const resolved = resolveModel(slot, settings.models[slot], available)
    if (resolved !== settings.models[slot]) next[slot] = resolved
  }
  return Object.keys(next).length ? ({ models: next } as Partial<Settings>) : null
}

// ---------------------------------------------------------------------------
// Prompt library — the part Cluely keeps server-side; here it is yours to edit.
// ---------------------------------------------------------------------------

export const MODE_PROMPTS: Record<Mode, string> = {
  assist:
    'You are Specter, a discreet real-time assistant living in a small overlay on the user\'s screen. ' +
    'You may receive a screenshot of what the user is looking at. Infer what the user needs right now ' +
    'from the screen and any question they type. Be sharp and concise: lead with the answer, use short ' +
    'markdown bullets when helpful, never narrate obvious things, never mention that you saw a screenshot. ' +
    'If the request is about code, return the exact code. If it is a multiple-choice or on-screen question, ' +
    'answer the option directly with a one-line reason.',
  meeting:
    'You are a live meeting copilot. You receive a rolling transcript labeled "Me" (the user) and "Them". ' +
    'Give the user exactly what to say or know right now: if a question was just asked, answer it; if a ' +
    'decision is open, recommend one with a short reason; if the user is talking, give their next talking point. ' +
    'Maximum 4 short bullets. No preamble, no repetition of the transcript.',
  interview:
    'You are helping the user answer interview and screening questions in real time. ' +
    'Reply ONLY with the words the user should say: first person, natural spoken English, confident, ' +
    'under 120 words unless code is asked for. No labels, no headers, no explanations about the answer. ' +
    'For coding questions return clean final code with a one-sentence explanation after it.',
  custom: ''
}
