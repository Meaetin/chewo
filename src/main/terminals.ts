import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { Source } from '../shared/adapter'

export interface CreateTerminalOptions {
  source: Source
  /** Resume this session; omit for a fresh one */
  sessionId?: string
  /** Working directory — the session's original project when resuming */
  cwd?: string | null
}

const terminals = new Map<number, pty.IPty>()
let nextId = 1

function buildCommand(opts: CreateTerminalOptions): string {
  if (opts.source === 'claude') {
    return opts.sessionId ? `claude --resume ${opts.sessionId}` : 'claude'
  }
  return opts.sessionId ? `codex resume ${opts.sessionId}` : 'codex'
}

export function createTerminal(win: BrowserWindow, opts: CreateTerminalOptions): number {
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
  // Login+interactive zsh so the user's PATH (nvm, homebrew, …) resolves the
  // CLI — a packaged Electron app does not inherit the shell environment.
  const proc = pty.spawn('/bin/zsh', ['-il', '-c', buildCommand(opts)], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>
  })

  const id = nextId++
  terminals.set(id, proc)

  proc.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('terminal:data', { id, data })
  })
  proc.onExit(({ exitCode }) => {
    terminals.delete(id)
    if (!win.isDestroyed()) win.webContents.send('terminal:exit', { id, exitCode })
  })

  return id
}

export function writeTerminal(id: number, data: string): void {
  terminals.get(id)?.write(data)
}

export function resizeTerminal(id: number, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) terminals.get(id)?.resize(cols, rows)
}

export function killTerminal(id: number): void {
  terminals.get(id)?.kill()
  terminals.delete(id)
}

export function disposeAllTerminals(): void {
  for (const proc of terminals.values()) proc.kill()
  terminals.clear()
}
