import type { BrowserWindow } from 'electron'

/**
 * Send to the renderer without racing teardown. `isDestroyed()` alone is not
 * enough: during reloads/quit the render frame can be disposed while the
 * window object is still alive, and `webContents.send` then throws
 * ("Render frame was disposed before WebFrameMain could be accessed").
 * Events lost during a reload are fine — the renderer re-syncs on mount.
 */
export function safeSend(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch {
    /* frame torn down between the check and the send — drop the event */
  }
}
