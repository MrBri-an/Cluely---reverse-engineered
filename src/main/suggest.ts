import type { Settings, SuggestionEvent } from '../shared/types'
import { chatOnce, resolveModel } from './groq'
import { captureScreenshot } from './capture'
import { sessions } from './sessions'

/**
 * Smart mode (beyond Cluely): periodically looks at the last transcript lines
 * (plus an optional screenshot) and decides whether there is something worth
 * saying right now. A single cheap call returns the suggestion or the literal
 * token SILENT — no separate classifier call.
 */
export class AutoSuggest {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private abort: AbortController | null = null

  private emit: ((s: SuggestionEvent) => void) | null = null
  private keyProvider: (() => string | null) | null = null
  private settingsProvider: (() => Settings) | null = null

  wire(emit: (s: SuggestionEvent) => void, keyProvider: () => string | null, settingsProvider: () => Settings): void {
    this.emit = emit
    this.keyProvider = keyProvider
    this.settingsProvider = settingsProvider
  }

  sync(): void {
    const s = this.settingsProvider?.()
    if (!s || !s.autoSuggest || !s.hasApiKey) {
      this.stop()
      return
    }
    this.start(s.autoSuggestIntervalSec * 1000)
  }

  start(intervalMs: number): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.tick(), Math.max(8, intervalMs))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.abort?.abort()
    this.abort = null
  }

  async tick(): Promise<void> {
    if (this.busy || !this.keyProvider || !this.settingsProvider || !this.emit) return
    const settings = this.settingsProvider()
    const key = this.keyProvider()
    if (!key || !sessions.session?.active) return
    const transcript = sessions.recentTranscript(14)
    if (!transcript && settings.screenUse !== 'always') return

    this.busy = true
    this.abort = new AbortController()
    try {
      const parts: Array<Record<string, unknown>> = [
        {
          type: 'text',
          text:
            'You are a live meeting copilot. Below is the recent conversation. Decide whether the user needs help RIGHT NOW ' +
            '(a question was asked to them, a decision is open, they are stuck, or a key term needs explaining). ' +
            'If nothing needs saying, reply with exactly: SILENT\n' +
            'If it does, reply with the concise thing to say (max 3 short bullets, no preamble).\n\n' +
            `Recent conversation:\n${transcript}`
        }
      ]
      if (settings.screenUse === 'always') {
        try {
          parts.push({ type: 'image_url', image_url: { url: await captureScreenshot() } })
        } catch {
          /* screenshot unavailable — proceed text-only */
        }
      }
      const text = await chatOnce(key, {
        model: resolveModel('fast', settings.models.fast),
        messages: [
          {
            role: 'system',
            content:
              'You output either the literal word SILENT or a short actionable suggestion. No other formats.'
          },
          { role: 'user', content: parts }
        ],
        maxTokens: 200,
        signal: this.abort.signal
      })
      const clean = text.trim()
      if (clean && !/^silent$/i.test(clean)) {
        this.emit({ id: `sug-${Date.now()}`, text: clean, at: Date.now() })
      }
    } catch {
      /* transient network/model errors: skip this tick */
    } finally {
      this.busy = false
      this.abort = null
    }
  }
}

export const autoSuggest = new AutoSuggest()
