import type { BrowserWindow } from 'electron'
import { setCommitListener } from '../shared/todos-store'
import { safeSend } from './safe-send'

/**
 * Main's view of the todo store: the store itself is Electron-free (shared,
 * so the context-bridge MCP server calls the same functions out of process);
 * main only wires the renderer push onto every commit.
 */
export * from '../shared/todos-store'

export function setTodosWindow(win: BrowserWindow): void {
  setCommitListener((scopeDir) => safeSend(win, 'todos:changed', { scopeDir }))
}
