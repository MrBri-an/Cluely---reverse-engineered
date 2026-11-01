import { globalShortcut } from 'electron'
import type { ShortcutAction, Settings } from '../shared/types'

/**
 * Global hotkeys, rebind-safe (mirrors Cluely's shortcuts domain):
 * unregister the old accelerator before registering the new one; suppressed
 * while the dashboard is recording a new binding.
 */
class Shortcuts {
  private registered: Partial<Record<ShortcutAction, string>> = {}
  private handlers: Record<ShortcutAction, () => void>
  private recording = false

  constructor(handlers: Record<ShortcutAction, () => void>) {
    this.handlers = handlers
  }

  setRecording(recording: boolean): void {
    this.recording = recording
  }

  private lastSettings: Settings | null = null

  apply(settings: Settings): void {
    this.lastSettings = settings
    this.recording = false // a settings save ends any in-progress hotkey capture
    for (const action of Object.keys(settings.shortcuts) as ShortcutAction[]) {
      const accelerator = settings.shortcuts[action]
      this.registerOne(action, accelerator)
    }
  }

  private registerOne(action: ShortcutAction, accelerator: string): void {
    try {
      const old = this.registered[action]
      if (old && old !== accelerator) {
        globalShortcut.unregister(old)
        this.registered[action] = undefined
      }
      if (!accelerator) {
        if (old) globalShortcut.unregister(old)
        this.registered[action] = undefined
        return
      }
      if (old === accelerator) return
      // conflicts with an OS-reserved combo simply fail; log and continue
      const ok = globalShortcut.register(accelerator, () => {
        if (this.recording) return
        try {
          this.handlers[action]?.()
        } catch {
          /* handler errors must never kill the shortcut */
        }
      })
      if (ok) this.registered[action] = accelerator
    } catch {
      /* invalid accelerator string — skip */
    }
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll()
    this.registered = {}
  }
}

export function createShortcuts(handlers: Record<ShortcutAction, () => void>): Shortcuts {
  return new Shortcuts(handlers)
}
