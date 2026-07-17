import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { Source } from '../shared/adapter'
import type { UnboundPane } from '../shared/projects'
import { safeSend } from './safe-send'

/** What a pane runs: an agent CLI or a plain shell */
export type PaneSource = Source | 'shell'

export interface CreateTerminalOptions {
  source: PaneSource
  /** Resume this session; omit for a fresh one (agents only) */
  sessionId?: string
  /** Working directory — the session's original project when resuming */
  cwd?: string | null
  /** Runs visibly before the agent (worktree setup: env copy, install); a failure blocks the agent launch */
  setupCommand?: string
}

interface PaneRecord {
  proc: pty.IPty
  source: PaneSource
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

/** null = plain interactive shell, no command */
export function buildCommand(opts: CreateTerminalOptions): string | null {
  if (opts.source === 'shell') return null
  const agent =
    opts.source === 'claude'
      ? opts.sessionId
        ? `claude --resume ${opts.sessionId}`
        : 'claude'
      : opts.sessionId
        ? `codex resume ${opts.sessionId}`
        : 'codex'
  return opts.setupCommand ? `(${opts.setupCommand}) && ${agent}` : agent
}

export function createTerminal(win: BrowserWindow, opts: CreateTerminalOptions): number {
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
  // Login+interactive zsh so the user's PATH (nvm, homebrew, …) resolves the
  // CLI — a packaged Electron app does not inherit the shell environment.
  const command = buildCommand(opts)
  const proc = pty.spawn('/bin/zsh', command ? ['-il', '-c', command] : ['-il'], {
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
    safeSend(win, 'terminal:data', { id, data })
  })
  proc.onExit(({ exitCode }) => {
    terminals.delete(id)
    safeSend(win, 'terminal:exit', { id, exitCode })
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

// Debounce nudges per agent so rapid handoffs don't concatenate typed text
const lastNudgeMs = new Map<Source, number>()
const NUDGE_DEBOUNCE_MS = 5000

/**
 * Type a visible "check your inbox" into the most recent live pane of the
 * target agent. Deliberately no Enter — the user reviews and submits.
 * Returns false when no pane of that agent is open.
 */
export function nudgeAgentPane(source: Source): boolean {
  let best: PaneRecord | undefined
  for (const rec of terminals.values()) {
    if (rec.source === source && (!best || rec.spawnedAtMs > best.spawnedAtMs)) best = rec
  }
  if (!best) return false
  const last = lastNudgeMs.get(source) ?? 0
  if (Date.now() - last > NUDGE_DEBOUNCE_MS) {
    best.proc.write('check your inbox')
    lastNudgeMs.set(source, Date.now())
  }
  return true
}

/** Agent panes spawned fresh whose session id we haven't identified yet.
 *  Shell panes have no session and never participate in binding. */
export function getUnboundPanes(): UnboundPane[] {
  const out: UnboundPane[] = []
  for (const [termId, rec] of terminals) {
    if (!rec.sessionId && rec.source !== 'shell') {
      out.push({ termId, source: rec.source, cwd: rec.cwd, spawnedAtMs: rec.spawnedAtMs })
    }
  }
  return out
}

export function bindPaneSession(termId: number, sessionId: string): void {
  const rec = terminals.get(termId)
  if (rec) rec.sessionId = sessionId
}
