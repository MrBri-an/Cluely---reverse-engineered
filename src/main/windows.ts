import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from 'electron'
import { join } from 'path'
import type { Settings } from '../shared/types'

/**
 * Window management — the stealth core (mirrors Cluely's mechanism, minus the plumbing):
 *  - type "panel" (mac) + alwaysOnTop('screen-saver') + skipTaskbar + frameless + transparent
 *  - dynamic focusability (noFocusWhenInvisible)
 *  - setContentProtection(true) → SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows:
 *    the window is removed from every screen capture, share and recording, while staying visible
 *    on the physical display. This is the entire "invisible to Zoom/Meet/Teams" trick.
 *  - smart click-through: ignore mouse events except over interactive UI (forwarded moves).
 */

/** Dev: electron-vite serves both renderer entries from one dev server root.
 *  Prod: built HTML lives at out/renderer/<entry>/index.html. */
function rendererUrl(entry: string): string | null {
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? `${dev}/${entry}/index.html` : null
}

function rendererFile(entry: string): string {
  return join(__dirname, `../renderer/${entry}/index.html`)
}

let overlay: BrowserWindow | null = null
let dashboard: BrowserWindow | null = null
let tray: Tray | null = null

export const PILL_SIZE = { width: 340, height: 56 }
export const PANEL_SIZE = { width: 660, height: 640 }

function pillPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width / 2 - PILL_SIZE.width / 2),
    y: workArea.y + 12
  }
}

export function getOverlay(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}

export function getDashboard(): BrowserWindow | null {
  return dashboard && !dashboard.isDestroyed() ? dashboard : null
}

function applyProtection(win: BrowserWindow, settings: Settings): void {
  win.setContentProtection(settings.invisible)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (settings.noFocusWhenInvisible) {
    // stay keyboard-activatable on click, but never steal focus from the host app on show
    win.setFocusable(true)
  }
}

export function createOverlay(settings: Settings): BrowserWindow {
  if (overlay) return overlay
  const pos = pillPosition()
  overlay = new BrowserWindow({
    width: PILL_SIZE.width,
    height: PILL_SIZE.height,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    type: process.platform === 'darwin' ? 'panel' : 'normal',
    title: 'Specter',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  applyProtection(overlay, settings)

  const overlayUrl = rendererUrl('overlay')
  if (overlayUrl) {
    void overlay.loadURL(overlayUrl)
  } else {
    void overlay.loadFile(rendererFile('overlay'))
  }

  overlay.once('ready-to-show', () => {
    if (process.env.SPECTER_SMOKE !== '1') overlay?.showInactive()
  })

  // keep the pill on screen if the display layout changes
  const reposition = (): void => {
    const win = getOverlay()
    if (!win) return
    const pos = pillPosition()
    win.setPosition(pos.x, pos.y)
  }
  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)

  return overlay
}

export function setOverlayExpanded(expanded: boolean): void {
  const win = getOverlay()
  if (!win) return
  const pos = pillPosition()
  win.setResizable(true)
  if (expanded) {
    // keep left edge anchored while growing
    const b = win.getBounds()
    win.setBounds({
      x: Math.max(screen.getPrimaryDisplay().workArea.x, b.x + b.width / 2 - PANEL_SIZE.width / 2),
      y: Math.max(screen.getPrimaryDisplay().workArea.y + 8, b.y),
      width: PANEL_SIZE.width,
      height: PANEL_SIZE.height
    })
  } else {
    const b = win.getBounds()
    const center = b.x + b.width / 2
    win.setBounds({
      x: Math.round(center - PILL_SIZE.width / 2),
      y: b.y,
      width: PILL_SIZE.width,
      height: PILL_SIZE.height
    })
    win.setPosition(pos.x, pos.y)
  }
  win.setResizable(false)
}

export function moveOverlayBy(dx: number, dy: number): void {
  const win = getOverlay()
  if (!win) return
  const b = win.getBounds()
  win.setPosition(b.x + dx, b.y + dy)
}

export function positionPill(): void {
  const win = getOverlay()
  if (!win) return
  const pos = pillPosition()
  const b = win.getBounds()
  win.setPosition(pos.x, pos.y)
  void b
}

export function showOverlay(): void {
  const win = getOverlay()
  if (!win) return
  win.showInactive()
}

export function hideOverlay(): void {
  const win = getOverlay()
  if (!win) return
  win.hide()
}

export function toggleOverlayVisible(): boolean {
  const win = getOverlay()
  if (!win) return false
  if (win.isVisible()) {
    win.hide()
    return false
  }
  win.showInactive()
  return true
}

export function setIgnoreMouse(ignore: boolean): void {
  const win = getOverlay()
  if (!win) return
  win.setIgnoreMouseEvents(ignore, { forward: true })
}

export function createDashboard(settings: Settings): BrowserWindow {
  if (dashboard) {
    dashboard.show()
    dashboard.focus()
    return dashboard
  }
  dashboard = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    title: 'Specter — Dashboard',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  dashboard.setContentProtection(settings.invisible)
  const url = rendererUrl('dashboard')
  if (url) {
    void dashboard.loadURL(url)
  } else {
    void dashboard.loadFile(rendererFile('dashboard'))
  }
  dashboard.once('ready-to-show', () => dashboard?.show())
  dashboard.on('close', (e) => {
    // dashboard closing hides it; the app keeps running in the tray
    if (!(dashboard as BrowserWindow & { __forceClose?: boolean }).__forceClose) {
      e.preventDefault()
      dashboard?.hide()
    }
  })
  return dashboard
}

export function closeAllWindowsForQuit(): void {
  for (const win of [overlay, dashboard]) {
    if (win && !win.isDestroyed()) {
      ;(win as BrowserWindow & { __forceClose?: boolean }).__forceClose = true
      win.close()
    }
  }
  overlay = null
  dashboard = null
}

/** 16×16 tray glyph drawn in-process (no binary asset needed). */
function trayIcon(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const cx = size / 2 - 0.5
  const cy = size / 2 - 0.5
  const r = 5.2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy)
      const i = (y * size + x) * 4
      if (d <= r) {
        const alpha = d > r - 1.4 ? Math.round(((r - d) / 1.4) * 255) : 255
        // BGRA
        buf[i] = 255
        buf[i + 1] = 255
        buf[i + 2] = 255
        buf[i + 3] = alpha
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

export function createTray(onShow: () => void, onQuit: () => void, onInvisible: () => void): void {
  try {
    tray = new Tray(trayIcon())
    tray.setToolTip('Specter')
    const menu = Menu.buildFromTemplate([
      { label: 'Show overlay', click: onShow },
      { label: 'Toggle invisibility (capture exclusion)', click: onInvisible },
      { type: 'separator' },
      { label: 'Quit Specter', click: onQuit }
    ])
    tray.setContextMenu(menu)
    tray.on('click', onShow)
  } catch {
    // tray is cosmetic; ignore failures (e.g., headless environments)
  }
}

export function onAppQuitting(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
  void app
}
