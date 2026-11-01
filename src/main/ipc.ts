import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { AskEvent, ChatRequest, Settings } from '../shared/types'
import {
  MODE_PROMPTS,
  chatStream,
  getAvailableModels,
  listModels,
  migrateModels,
  resolveModel,
  setAvailableModels,
  transcribeWav,
  visionAvailable
} from './groq'
import { captureScreenshot } from './capture'
import { sessions } from './sessions'
import { loadApiKey, patchSettings, removeApiKey, storeApiKey } from './settings'
import {
  createDashboard,
  getOverlay,
  hideOverlay,
  moveOverlayBy,
  setIgnoreMouse,
  setOverlayExpanded,
  showOverlay
} from './windows'

interface IpcDeps {
  getSettings: () => Settings
  onSettingsPatched: (s: Settings) => void
  onTranscribing: (u: { role: 'me' | 'them'; busy: boolean }) => void
  onSuggestion: (s: { id: string; text: string; at: number }) => void
  onAskEvent: (e: AskEvent) => void
  onShortcut: (a: string) => void
  requestShortcutRebind: () => void
}

const activeAsks = new Map<string, AbortController>()

export function registerIpc(deps: IpcDeps): void {
  /** Fetches /models with the stored key, migrates stale configured models, and returns the list. */
  const fetchAndMigrateModels = async (): Promise<string[]> => {
    const key = loadApiKey()
    if (!key) return []
    try {
      const models = await listModels(key)
      setAvailableModels(models.map((m) => m.id))
      const migration = migrateModels(deps.getSettings(), getAvailableModels())
      if (migration) {
        const next = patchSettings(migration)
        deps.onSettingsPatched(next)
      }
      return getAvailableModels()
    } catch {
      return getAvailableModels()
    }
  }
  // ---- settings & key ----
  ipcMain.handle('settings:get', () => deps.getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
    // renderers can never write the API key through settings
    const next = patchSettings(patch)
    deps.onSettingsPatched(next)
    return next
  })
  ipcMain.handle('key:set', async (_e, key: string) => {
    const trimmed = (key ?? '').trim()
    if (!trimmed) return { ok: false, error: 'Empty key' }
    try {
      const models = await listModels(trimmed)
      setAvailableModels(models.map((m) => m.id))
      storeApiKey(trimmed)
      const next = patchSettings({ hasApiKey: true })
      const migration = migrateModels(next, getAvailableModels())
      const finalSettings = migration ? patchSettings(migration) : next
      deps.onSettingsPatched(finalSettings)
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('key:clear', () => {
    removeApiKey()
    const next = patchSettings({ hasApiKey: false })
    deps.onSettingsPatched(next)
  })
  ipcMain.handle('key:validate', async () => {
    const key = loadApiKey()
    if (!key) return { ok: false, error: 'No key stored' }
    try {
      const models = await listModels(key)
      setAvailableModels(models.map((m) => m.id))
      const migration = migrateModels(deps.getSettings(), getAvailableModels())
      if (migration) {
        const next = patchSettings(migration)
        deps.onSettingsPatched(next)
      }
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('models:list', async () => {
    await fetchAndMigrateModels()
    return getAvailableModels().map((id) => ({ id }))
  })

  // ---- session / transcript ----
  ipcMain.handle('session:get', () => ({ session: sessions.session, transcript: sessions.transcript }))
  ipcMain.handle('session:start', () => sessions.start())
  ipcMain.handle('session:end', () => {
    sessions.end()
  })
  ipcMain.handle('transcript:clear', () => {
    sessions.clearTranscript()
  })
  ipcMain.handle('stt:transcribe', async (_e, req: { role: 'me' | 'them'; wav: ArrayBuffer; language?: string }) => {
    const key = loadApiKey()
    if (!key) return { ok: false, error: 'No API key' }
    const settings = deps.getSettings()
    deps.onTranscribing({ role: req.role, busy: true })
    try {
      const text = await transcribeWav(key, settings.models.stt, req.wav, req.language)
      const entry = sessions.addEntry(req.role, text)
      return { ok: true, entry }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      deps.onTranscribing({ role: req.role, busy: false })
    }
  })

  // ---- chat ----
  ipcMain.handle('chat:ask', async (_e, req: ChatRequest) => {
    const key = loadApiKey()
    if (!key) {
      deps.onAskEvent({ id: 'n/a', type: 'error', text: 'No Groq API key configured. Open the dashboard to add one.' })
      return { id: 'n/a' }
    }
    const settings = deps.getSettings()
    const id = randomUUID()
    const abort = new AbortController()
    activeAsks.set(id, abort)

    const messages: Array<{ role: string; content: unknown }> = []
    const modePrompt = req.mode === 'custom' ? settings.customPrompt || MODE_PROMPTS.assist : MODE_PROMPTS[req.mode]
    messages.push({ role: 'system', content: modePrompt })

    const contextChunks: string[] = []
    if (req.includeTranscript) {
      const t = sessions.recentTranscript(24)
      if (t) contextChunks.push(`<transcript>\n${t}\n</transcript>`)
    }
    if (req.prompt.trim()) contextChunks.push(`<user_request>\n${req.prompt.trim()}\n</user_request>`)

    // vision model when we attach the screen; text model otherwise.
    // If the key has no multimodal model (common on free tier), degrade to
    // text-only on the chat model and tell the user instead of failing.
    const useScreen = req.includeScreen || !!req.screenshot
    let effectiveScreen = useScreen
    if (useScreen && !visionAvailable(getAvailableModels())) {
      effectiveScreen = false
      deps.onAskEvent({
        id,
        type: 'notice',
        text: 'Screen reading is unavailable: this Groq key has no multimodal model. Answering from text context only.'
      })
    }
    const model = effectiveScreen
      ? resolveModel('vision', settings.models.vision)
      : resolveModel('chat', settings.models.chat)

    let content: unknown = contextChunks.join('\n\n')
    if (effectiveScreen) {
      const dataUrl = req.screenshot?.dataUrl ?? (await captureScreenshot(getOverlay()).catch(() => null))
      if (dataUrl) {
        content = [
          { type: 'text', text: contextChunks.join('\n\n') || 'Here is what is on my screen right now. Infer what I need and answer.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    }
    messages.push({ role: 'user', content })

    void chatStream(key, {
      model,
      messages,
      onDelta: (delta) => deps.onAskEvent({ id, type: 'delta', text: delta }),
      signal: abort.signal
    })
      .then((full) => deps.onAskEvent({ id, type: 'done', text: full }))
      .catch((err) => {
        if ((err as Error).name === 'AbortError') deps.onAskEvent({ id, type: 'done', text: '' })
        else deps.onAskEvent({ id, type: 'error', text: (err as Error).message })
      })
      .finally(() => activeAsks.delete(id))
    return { id }
  })
  ipcMain.handle('chat:cancel', (_e, id: string) => {
    activeAsks.get(id)?.abort()
    activeAsks.delete(id)
  })

  // ---- window controls ----
  ipcMain.handle('overlay:setExpanded', (_e, expanded: boolean) => {
    setOverlayExpanded(expanded)
  })
  ipcMain.handle('overlay:moveBy', (_e, dx: number, dy: number) => {
    moveOverlayBy(Math.round(dx), Math.round(dy))
  })
  ipcMain.handle('overlay:setIgnoreMouse', (_e, ignore: boolean) => {
    setIgnoreMouse(ignore)
  })
  ipcMain.handle('overlay:hide', () => {
    hideOverlay()
  })
  ipcMain.handle('overlay:show', () => {
    showOverlay()
  })
  ipcMain.handle('app:openDashboard', () => {
    createDashboard(deps.getSettings())
  })
  ipcMain.handle('app:quit', () => {
    app.quit()
  })
  ipcMain.handle('screen:capture', async () => {
    const dataUrl = await captureScreenshot(getOverlay())
    return { dataUrl }
  })
  ipcMain.handle('app:notifyShortcut', (_e, action: string) => {
    deps.onShortcut(action)
  })
  ipcMain.on('audio:level', (_e, payload: { role: 'me' | 'them'; level: number }) => {
    // rebroadcast so the dashboard can show live meters
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('audio:level', payload)
    }
  })
  ipcMain.handle('shortcuts:requestRebind', () => {
    deps.requestShortcutRebind()
  })
}
