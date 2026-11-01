import { randomUUID } from 'crypto'
import type { SessionInfo, TranscriptEntry, TranscriptUpdate } from '../shared/types'

class SessionStore {
  session: SessionInfo | null = null
  transcript: TranscriptEntry[] = []
  // parallel transcript entries that are being transcribed right now
  private listeners: Array<(u: TranscriptUpdate) => void> = []
  private sessionListeners: Array<(s: SessionInfo | null) => void> = []

  onUpdate(cb: (u: TranscriptUpdate) => void): void {
    this.listeners.push(cb)
  }

  onSessionChanged(cb: (s: SessionInfo | null) => void): void {
    this.sessionListeners.push(cb)
  }

  start(): SessionInfo {
    if (this.session?.active) return this.session // idempotent: lane retries must not wipe the transcript
    this.session = { id: randomUUID(), startedAt: Date.now(), active: true }
    this.transcript = []
    this.sessionListeners.forEach((cb) => cb(this.session))
    return this.session
  }

  end(): void {
    this.session = null
    this.sessionListeners.forEach((cb) => cb(null))
  }

  clearTranscript(): void {
    this.transcript = []
    this.listeners.forEach((cb) => cb({ kind: 'cleared' }))
  }

  addEntry(role: 'me' | 'them', text: string): TranscriptEntry | null {
    text = text.trim()
    if (!text || !this.session) return null
    const entry: TranscriptEntry = { id: randomUUID(), role, text, at: Date.now() }
    this.transcript.push(entry)
    // keep memory bounded: last 500 entries
    if (this.transcript.length > 500) this.transcript.splice(0, this.transcript.length - 500)
    this.listeners.forEach((cb) => cb({ kind: 'added', entry }))
    return entry
  }

  recentTranscript(count = 30): string {
    return this.transcript
      .slice(-count)
      .map((e) => `- ${e.role === 'me' ? 'Me' : 'Them'}: ${e.text}`)
      .join('\n')
  }
}

export const sessions = new SessionStore()
