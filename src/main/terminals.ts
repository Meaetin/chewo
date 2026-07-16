import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { Source } from '../shared/adapter'
import type { UnboundPane } from '../shared/projects'

export interface CreateTerminalOptions {
  source: Source
  /** Resume this session; omit for a fresh one */
  sessionId?: string
  /** Working directory — the session's original project when resuming */
  cwd?: string | null
}

interface PaneRecord {
  proc: pty.IPty
  source: Source
  cwd: string
  spawnedAtMs: number
  /** Known immediately when resuming; bound later (via the session-store watcher) when fresh */
  sessionId?: string
}

const terminals = new Map<number, PaneRecord>()
let nextId = 1

/**
 * The app (or the dev server) may itself have been launched from inside a
 * Claude Code session. Those inherited env vars make a spawned `claude`
 * treat itself as a nested child session and SKIP writing its session file
 * entirely — breaking the sidebar, binding, and resume. Scrub them.
 */
export function buildPtyEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) continue
    env[key] = value
  }
  return env
}

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
    env: buildPtyEnv(process.env)
  })

  const id = nextId++
  terminals.set(id, {
    proc,
    source: opts.source,
    cwd,
    spawnedAtMs: Date.now(),
    sessionId: opts.sessionId
  })

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
  terminals.get(id)?.proc.write(data)
}

export function resizeTerminal(id: number, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) terminals.get(id)?.proc.resize(cols, rows)
}

export function killTerminal(id: number): void {
  terminals.get(id)?.proc.kill()
  terminals.delete(id)
}

export function disposeAllTerminals(): void {
  for (const rec of terminals.values()) rec.proc.kill()
  terminals.clear()
}

/** Panes spawned fresh whose session id we haven't identified yet. */
export function getUnboundPanes(): UnboundPane[] {
  const out: UnboundPane[] = []
  for (const [termId, rec] of terminals) {
    if (!rec.sessionId) {
      out.push({ termId, source: rec.source, cwd: rec.cwd, spawnedAtMs: rec.spawnedAtMs })
    }
  }
  return out
}

export function bindPaneSession(termId: number, sessionId: string): void {
  const rec = terminals.get(termId)
  if (rec) rec.sessionId = sessionId
}
