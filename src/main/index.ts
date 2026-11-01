import { app, BrowserWindow, desktopCapturer, session } from 'electron'
import { join } from 'path'

// Pin the profile dir so every launch mode (electron-vite dev, preview,
// packaged binary, scripted smoke) shares one userData — settings, the
// safeStorage-encrypted key and the os_crypt Local State key live here.
// Without this, launching electron with a bare script path yields the
// "Electron" profile instead of "specter".
app.setName('specter')
app.setPath('userData', join(app.getPath('appData'), 'specter'))
import type { AskEvent, Settings, ShortcutAction, SuggestionEvent, TranscriptUpdate } from '../shared/types'
import { captureScreenshot } from './capture'
import { registerIpc } from './ipc'
import { getAvailableModels, listModels, migrateModels, setAvailableModels } from './groq'
import { loadApiKey, loadSettings, patchSettings } from './settings'
import { autoSuggest } from './suggest'
import { createShortcuts } from './shortcuts'
import { sessions } from './sessions'
import {
  closeAllWindowsForQuit,
  createDashboard,
  createOverlay,
  createTray,
  getOverlay,
  moveOverlayBy,
  setOverlayExpanded,
  showOverlay,
  toggleOverlayVisible
} from './windows'

/**
 * Specter — invisible AI overlay powered by Groq.
 * Architecture reverse-engineered from Cluely v2.0.199 (see re/CLUELY-RE-REPORT.md).
 */

const SMOKE = process.env.SPECTER_SMOKE === '1'

let settings: Settings = loadSettings()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const shortcuts = createShortcuts({
  toggleVisibility: () => {
    const visible = toggleOverlayVisible()
    broadcast('overlay:visibility', { visible })
  },
  toggleExpanded: () => {
    settings = patchSettings({ expanded: !settings.expanded })
    setOverlayExpanded(settings.expanded)
    broadcast('settings:changed', settings)
  },
  ask: () => {
    showOverlay()
    broadcast('shortcut', 'ask')
  },
  clear: () => {
    sessions.clearTranscript()
    broadcast('transcript:update', { kind: 'cleared' } satisfies TranscriptUpdate)
    broadcast('chat:cleared', {})
  },
  toggleSession: () => {
    if (sessions.session?.active) {
      sessions.end()
      autoSuggest.sync()
    } else {
      sessions.start()
      autoSuggest.sync()
    }
    broadcast('session:changed', sessions.session)
  },
  toggleInvisible: () => {
    settings = patchSettings({ invisible: !settings.invisible })
    const overlay = getOverlay()
    overlay?.setContentProtection(settings.invisible)
    broadcast('settings:changed', settings)
  },
  moveUp: () => moveOverlayBy(0, -24),
  moveDown: () => moveOverlayBy(0, 24),
  moveLeft: () => moveOverlayBy(-24, 0),
  moveRight: () => moveOverlayBy(24, 0)
})

function applySettings(next: Settings): void {
  settings = next
  const overlay = getOverlay()
  overlay?.setContentProtection(next.invisible)
  shortcuts.apply(next)
  autoSuggest.sync()
  broadcast('settings:changed', next)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showOverlay()
  })

  app.whenReady().then(async () => {
    // Auto-approve screen sharing requests from the overlay renderer and hand it
    // system loopback audio (Windows WASAPI loopback) — no picker, no bot, no meeting join.
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        if (sources[0]) {
          console.log('[display-media] approving screen source + loopback audio')
          callback({ video: sources[0], audio: 'loopback' as never })
        } else {
          console.error('[display-media] no screen sources available')
          callback({})
        }
      } catch (err) {
        console.error('[display-media] getSources failed:', err)
        callback({})
      }
    })

    createOverlay(settings)

    // warm the screen-capture subsystem immediately: the first getSources call
    // is slow on Windows, and a slow display-media handler gets the renderer's
    // loopback request aborted by Chromium at boot.
    void desktopCapturer.getSources({ types: ['screen'] }).catch(() => undefined)

    registerIpc({
      getSettings: () => settings,
      onSettingsPatched: applySettings,
      onTranscribing: (u) => broadcast('transcript:transcribing', u),
      onSuggestion: (s: SuggestionEvent) => broadcast('suggest:new', s),
      onAskEvent: (e: AskEvent) => broadcast('chat:askEvent', e),
      onShortcut: () => broadcast('shortcut', 'ask'),
      requestShortcutRebind: () => shortcuts.setRecording(true)
    })

    sessions.onUpdate((u) => broadcast('transcript:update', u))
    sessions.onSessionChanged((s) => broadcast('session:changed', s))
    autoSuggest.wire(
      (s) => broadcast('suggest:new', s),
      () => loadApiKey(),
      () => settings
    )

    createTray(
      () => showOverlay(),
      () => app.quit(),
      () => applySettings(patchSettings({ invisible: !settings.invisible }))
    )

    // onboard on first run: open the dashboard if no key is configured yet
    if (!settings.hasApiKey && !SMOKE) {
      createDashboard(settings)
    }

    shortcuts.apply(settings)
    autoSuggest.sync()

    // Groq's catalog changes — validate configured models against the key's
    // real /models list at boot and migrate any that no longer exist.
    const bootMigration: Promise<void> = (async () => {
      if (!settings.hasApiKey) return
      const key = loadApiKey()
      if (!key) return
      try {
        const models = await listModels(key)
        setAvailableModels(models.map((m) => m.id))
        const migration = migrateModels(settings, getAvailableModels())
        if (migration) applySettings(patchSettings(migration))
      } catch {
        /* offline — resolution falls back to configured ids */
      }
    })()

    // warm-up: pre-capture a screenshot so the first ask is fast (also proves capture works)
    if (!SMOKE) {
      setTimeout(() => void captureScreenshot(getOverlay()).catch(() => undefined), 4000)
    }

    if (SMOKE && process.env.SPECTER_SMOKE_KEEP !== '1') {
      setTimeout(() => {
        void Promise.race([
          bootMigration,
          new Promise((r) => setTimeout(r, 8000))
        ]).then(() => {
          console.log('SPECTER_SMOKE_OK windows=' + BrowserWindow.getAllWindows().length)
          closeAllWindowsForQuit()
          app.quit()
        })
      }, 1500)
    }
  })

  app.on('window-all-closed', () => {
    // keep running in tray — standard for overlay assistants
    if (SMOKE) app.quit()
  })

  app.on('before-quit', () => {
    shortcuts.unregisterAll()
    closeAllWindowsForQuit()
  })

  process.on('uncaughtException', (err) => {
    console.error('[specter] uncaught', err)
  })
}
