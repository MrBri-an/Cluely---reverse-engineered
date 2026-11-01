import { BrowserWindow, desktopCapturer, screen } from 'electron'

const MAX_SIDE = 1920

function scaleBounds(bounds: Electron.Rectangle): { width: number; height: number } {
  const longest = Math.max(bounds.width, bounds.height)
  if (longest <= MAX_SIDE) return { width: bounds.width, height: bounds.height }
  const r = MAX_SIDE / longest
  return { width: Math.round(bounds.width * r), height: Math.round(bounds.height * r) }
}

/**
 * Full-display screenshot as a PNG data URL, taken from the display the overlay is on.
 * Specter's own windows are content-protected, so they never appear in the capture.
 */
export async function captureScreenshot(overlay?: BrowserWindow | null): Promise<string> {
  const display = overlay
    ? screen.getDisplayMatching(overlay.getBounds())
    : screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: scaleBounds(display.bounds)
  })
  const source =
    sources.find((s) => s.display_id === display.id.toString()) ?? sources[0]
  if (!source) throw new Error('No display source found for screenshot')
  const thumbnail = source.thumbnail
  if (thumbnail.isEmpty()) throw new Error('Screenshot thumbnail empty (retry)')
  return `data:image/png;base64,${thumbnail.toPNG().toString('base64')}`
}
