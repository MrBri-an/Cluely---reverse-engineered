import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Settings, ShortcutAction } from '../shared/types'

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  toggleVisibility: 'CommandOrControl+\\',
  toggleExpanded: 'CommandOrControl+K',
  ask: 'CommandOrControl+Enter',
  clear: 'CommandOrControl+R',
  toggleSession: 'CommandOrControl+Shift+\\',
  toggleInvisible: 'CommandOrControl+Shift+I',
  moveUp: 'CommandOrControl+Up',
  moveDown: 'CommandOrControl+Down',
  moveLeft: 'CommandOrControl+Left',
  moveRight: 'CommandOrControl+Right'
}

const DEFAULTS: Settings = {
  hasApiKey: false,
  models: {
    chat: 'openai/gpt-oss-120b',
    fast: 'openai/gpt-oss-20b',
    vision: 'meta-llama/llama-4-scout-17b-16e-instruct',
    stt: 'whisper-large-v3-turbo'
  },
  invisible: true,
  noFocusWhenInvisible: true,
  micEnabled: false,
  screenUse: 'auto',
  autoSuggest: false,
  autoSuggestIntervalSec: 20,
  customPrompt: '',
  mode: 'assist',
  shortcuts: DEFAULT_SHORTCUTS,
  expanded: false
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'specter-settings.json')
}

function keyPath(): string {
  return join(app.getPath('userData'), 'specter-key.bin')
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    return {
      ...DEFAULTS,
      ...raw,
      models: { ...DEFAULTS.models, ...(raw.models ?? {}) },
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(raw.shortcuts ?? {}) }
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: Settings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

/** API key is stored encrypted with the OS-level safeStorage (DPAPI on Windows, Keychain on macOS). */
export function loadApiKey(): string | null {
  if (process.env.SPECTER_GROQ_API_KEY) return process.env.SPECTER_GROQ_API_KEY
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY
  try {
    if (!existsSync(keyPath())) return null
    const buf = readFileSync(keyPath())
    if (!safeStorage.isEncryptionAvailable()) return buf.toString('utf8')
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export function storeApiKey(key: string): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(keyPath(), safeStorage.encryptString(key))
  } else {
    writeFileSync(keyPath(), key, 'utf8')
  }
}

export function removeApiKey(): void {
  try {
    if (existsSync(keyPath())) writeFileSync(keyPath(), '')
  } catch {
    /* ignore */
  }
}

export function patchSettings(patch: Partial<Settings>): Settings {
  const next = {
    ...loadSettings(),
    ...patch,
    models: { ...loadSettings().models, ...(patch.models ?? {}) },
    shortcuts: { ...loadSettings().shortcuts, ...(patch.shortcuts ?? {}) }
  }
  saveSettings(next)
  return next
}
