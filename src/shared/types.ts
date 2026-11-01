// Shared types between main, preload and renderers.

export type Role = 'me' | 'them'

export type Mode = 'assist' | 'meeting' | 'interview' | 'custom'

export interface TranscriptEntry {
  id: string
  role: Role
  text: string
  at: number // epoch ms
}

export interface SessionInfo {
  id: string
  startedAt: number
  active: boolean
}

export type ChatState = 'idle' | 'streaming' | 'error'

export interface Settings {
  // Groq
  hasApiKey: boolean // key itself never leaves main; this only reflects storage
  models: {
    chat: string // text model
    fast: string // cheap/fast model (smart-suggest gate)
    vision: string // multimodal model (screenshot reasoning)
    stt: string // speech-to-text model
  }
  // Behavior
  invisible: boolean // content-protection (hidden from screen share / screenshots)
  noFocusWhenInvisible: boolean
  micEnabled: boolean // capture own mic in addition to system audio
  screenUse: 'off' | 'auto' | 'always'
  autoSuggest: boolean // periodic proactive suggestions (smart mode)
  autoSuggestIntervalSec: number
  customPrompt: string
  mode: Mode
  shortcuts: Record<ShortcutAction, string>
  expanded: boolean
}

export type ShortcutAction =
  | 'toggleVisibility'
  | 'toggleExpanded'
  | 'ask'
  | 'clear'
  | 'toggleSession'
  | 'toggleInvisible'
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'

export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ChatRequest {
  prompt: string
  mode: Mode
  includeScreen: boolean
  includeTranscript: boolean
  screenshot?: { dataUrl: string } // renderer-captured reference (optional)
}

export interface AskEvent {
  id: string
  type: 'delta' | 'done' | 'error' | 'notice'
  text?: string
}

export interface TranscriptUpdate {
  kind: 'added' | 'cleared'
  entry?: TranscriptEntry
}

export interface SuggestionEvent {
  id: string
  text: string
  at: number
}

export interface ModelInfo {
  id: string
  owned_by?: string
  active?: boolean
  context_window?: number
}

/** Public API exposed to renderers via contextBridge (window.specter). */
export interface SpecterApi {
  // events
  onTranscriptUpdate: (cb: (u: TranscriptUpdate) => void) => () => void
  onTranscribing: (cb: (u: { role: Role; busy: boolean }) => void) => () => void
  onAskEvent: (cb: (e: AskEvent) => void) => () => void
  onSuggestion: (cb: (s: SuggestionEvent) => void) => () => void
  onSettingsChanged: (cb: (s: Settings) => void) => () => void
  onSessionChanged: (cb: (s: SessionInfo | null) => void) => () => void
  onAudioLevel: (cb: (l: { role: Role; level: number }) => void) => () => void
  onShortcut: (cb: (a: ShortcutAction) => void) => () => void
  // actions
  getSettings: () => Promise<Settings>
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>
  setApiKey: (key: string) => Promise<{ ok: boolean; error?: string; models?: ModelInfo[] }>
  clearApiKey: () => Promise<void>
  validateKey: () => Promise<{ ok: boolean; error?: string; models?: ModelInfo[] }>
  listModels: () => Promise<ModelInfo[]>
  getSession: () => Promise<{ session: SessionInfo | null; transcript: TranscriptEntry[] }>
  startSession: () => Promise<SessionInfo>
  endSession: () => Promise<void>
  clearTranscript: () => Promise<void>
  ask: (req: ChatRequest) => Promise<{ id: string }>
  cancelAsk: (id: string) => Promise<void>
  // overlay window controls
  setExpanded: (expanded: boolean) => Promise<void>
  moveBy: (dx: number, dy: number) => Promise<void>
  setIgnoreMouse: (ignore: boolean) => Promise<void>
  hideOverlay: () => Promise<void>
  showOverlay: () => Promise<void>
  openDashboard: () => Promise<void>
  quitApp: () => Promise<void>
  // capture
  captureScreenshot: () => Promise<{ dataUrl: string }>
  transcribe: (req: { role: Role; wav: ArrayBuffer; language?: string }) => Promise<{
    ok: boolean
    entry?: TranscriptEntry
    error?: string
  }>
  emitAudioLevel: (role: Role, level: number) => void
  platform: NodeJS.Platform
}
