import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { DEFAULT_STT_MODEL } from '../shared/notes'
import {
  GENERAL_SCOPE,
  projectScopeDir,
  statusOf,
  TODO_STATUSES,
  TODO_STATUS_LABELS,
  type BoardFile,
  type HudState,
  type TodoStatus
} from '../shared/todos'
import {
  buildPrompt,
  COMMAND_SCHEMA,
  parseInterpreterOutput,
  type ScopeSnapshot,
  type TodoCommand
} from './todo-interpreter'
import { loadProjects } from './projects'
import { buildPtyEnv } from './terminals'
import { safeSend } from './safe-send'
import { sttOwner, sttStart, sttStop } from './stt'
import {
  addCard,
  deleteCard,
  loadBoard,
  moveCard,
  readAsset,
  restoreAssets,
  restoreBoard,
  todosRootPath,
  updateCard
} from './todos'

/**
 * Voice-command flow (SPEC-TODOS §6): a system-wide hotkey toggles capture
 * through the shared STT sidecar, a floating always-on-top HUD shows the
 * live transcript, and on stop a headless Sonnet call interprets the
 * utterance into one board command, executed immediately with an Undo.
 */

export const DEFAULT_TODO_HOTKEY = 'Command+.'

const HUD_WIDTH = 460
const HUD_HEIGHT = 176
const HUD_MIN_HEIGHT = 120
const HUD_MAX_HEIGHT = 480
const INTERPRET_TIMEOUT_MS = 60_000

type Phase = 'idle' | 'capturing' | 'thinking' | 'result'

let mainWin: BrowserWindow | null = null
let hud: BrowserWindow | null = null
let phase: Phase = 'idle'
let registeredHotkey: string | null = null
let hideTimer: NodeJS.Timeout | null = null
/** Pre-mutation snapshot per touched scope — Undo reverts the whole utterance */
let undoState: Map<
  string,
  { board: BoardFile; assets: Array<{ name: string; base64: string }> }
> | null = null

// ---------- HUD window ----------

function ensureHud(): BrowserWindow {
  if (hud && !hud.isDestroyed()) return hud
  hud = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    // Never steal focus — dictation happens over whatever app is frontmost
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  hud.setAlwaysOnTop(true, 'screen-saver')
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void hud.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/hud.html')
  } else {
    void hud.loadFile(join(__dirname, '../renderer/hud.html'))
  }
  return hud
}

function showHud(): void {
  const win = ensureHud()
  // Top-center of whichever display the cursor is on
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width } = display.workArea
  win.setPosition(Math.round(x + (width - HUD_WIDTH) / 2), y + 48)
  if (!win.isVisible()) win.showInactive()
}

function pushHud(state: HudState): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  safeSend(hud, 'hud:state', state)
}

function hideHudAfter(ms: number): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    phase = 'idle'
    hud?.hide()
  }, ms)
}

export function closeHud(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  if (hud && !hud.isDestroyed()) hud.close()
  hud = null
}

// ---------- capture ----------

function onHotkey(): void {
  if (phase === 'capturing') {
    phase = 'thinking'
    pushHud({ phase: 'thinking' })
    sttStop()
    return
  }
  if (phase === 'thinking') return // let the in-flight command land
  // Universal mic toggle: during a notes recording the hotkey stops that
  // dictation (its final flows to the notes renderer) instead of starting
  // a voice command
  if (sttOwner() === 'notes') {
    sttStop()
    return
  }
  startCapture()
}

function startCapture(): void {
  showHud()
  const err = sttStart(DEFAULT_STT_MODEL, 'todo', onSttEvent)
  if (err) {
    phase = 'idle'
    pushHud({ phase: 'error', message: `Mic is busy — ${err}.` })
    hideHudAfter(3000)
    return
  }
  phase = 'capturing'
  pushHud({ phase: 'capturing', confirmed: '', tail: '', level: 0, loading: false })
}

function onSttEvent(ev: {
  event: string
  rms?: number
  confirmed?: string
  tail?: string
  text?: string
  message?: string
}): void {
  switch (ev.event) {
    case 'loading':
      pushHud({ phase: 'capturing', loading: true })
      break
    case 'level':
      if (phase === 'capturing') pushHud({ phase: 'capturing', level: ev.rms ?? 0 })
      break
    case 'partial':
      if (phase === 'capturing')
        pushHud({
          phase: 'capturing',
          confirmed: ev.confirmed ?? '',
          tail: ev.tail ?? '',
          loading: false
        })
      break
    case 'final':
      phase = 'thinking'
      // The live transcript lags speech by seconds — surface the complete
      // utterance so the user sees what was actually heard
      pushHud({ phase: 'thinking', finalText: (ev.text ?? '').trim() })
      void handleFinal(ev.text ?? '')
      break
    case 'error':
      phase = 'idle'
      pushHud({ phase: 'error', message: ev.message ?? 'Dictation failed' })
      hideHudAfter(4000)
      break
  }
}

async function handleFinal(text: string): Promise<void> {
  const transcript = text.trim()
  if (!transcript) {
    phase = 'idle'
    pushHud({ phase: 'error', message: 'No speech captured.' })
    hideHudAfter(2500)
    return
  }
  try {
    const scopes = boardSnapshot()
    const commands = await interpret(transcript, scopes)
    const outcome = executeAll(commands, scopes)
    phase = 'result'
    pushHud({
      phase: 'result',
      summary: outcome.summary,
      undoable: outcome.undoable,
      finalText: transcript
    })
    hideHudAfter(outcome.undoable ? 10000 : 7000)
  } catch (err) {
    phase = 'idle'
    pushHud({
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
      finalText: transcript
    })
    hideHudAfter(7000)
  }
}

// ---------- interpreter ----------

function boardSnapshot(): ScopeSnapshot[] {
  const file = loadProjects()
  const scopes = [
    { scope: GENERAL_SCOPE, name: 'General' },
    ...file.projects.map((p) => ({ scope: projectScopeDir(p.name, p.path), name: p.name }))
  ]
  return scopes.map(({ scope, name }) => {
    const board = loadBoard(scope)
    const cards: ScopeSnapshot['cards'] = []
    for (const column of TODO_STATUSES) {
      for (const id of board.columns[column]) {
        const card = board.cards[id]
        if (card) cards.push({ id, title: card.title.slice(0, 80), column })
      }
    }
    return { scope, name, cards }
  })
}

function interpret(transcript: string, scopes: ScopeSnapshot[]): Promise<TodoCommand[]> {
  return new Promise((resolve, reject) => {
    // Schema is a compile-time constant (JSON — no single quotes to escape)
    const cmd =
      `claude -p --model sonnet --output-format json` + ` --json-schema '${COMMAND_SCHEMA}'`
    // cwd pins the session under ~/.chewo so the coding sidebar filters it
    const proc = spawn('/bin/zsh', ['-ilc', cmd], {
      cwd: todosRootPath(),
      env: buildPtyEnv(process.env)
    })

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Interpreter timed out.'))
    }, INTERPRET_TIMEOUT_MS)

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Interpreter failed to start: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Interpreter exited ${code}: ${stderr.slice(0, 160)}`))
        return
      }
      try {
        resolve(parseInterpreterOutput(stdout))
      } catch (err) {
        reject(err)
      }
    })

    proc.stdin.write(buildPrompt(transcript, scopes))
    proc.stdin.end()
  })
}

// ---------- execution ----------

/**
 * Run every command in utterance order. A command that fails leaves an
 * inline ✗ line and the rest still run; Undo reverts every touched scope
 * to its pre-utterance snapshot.
 */
function executeAll(
  commands: TodoCommand[],
  scopes: ScopeSnapshot[]
): { summary: string; undoable: boolean } {
  const snapshots = new Map<string, { board: BoardFile; assets: Array<{ name: string; base64: string }> }>()
  const lines: string[] = []
  let mutated = false

  for (const command of commands) {
    try {
      const line = executeOne(command, scopes, snapshots)
      lines.push(line.summary)
      mutated = mutated || line.mutated
    } catch (err) {
      lines.push(`✗ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  undoState = mutated ? snapshots : null
  return {
    summary: lines.join('\n') || 'Could not understand that.',
    undoable: mutated
  }
}

function executeOne(
  command: TodoCommand,
  scopes: ScopeSnapshot[],
  snapshots: Map<string, { board: BoardFile; assets: Array<{ name: string; base64: string }> }>
): { summary: string; mutated: boolean } {
  if (command.action === 'none')
    return { summary: command.text?.trim() || 'Could not understand that.', mutated: false }

  const scope = scopes.find((s) => s.scope === command.scope)
  if (!scope) throw new Error(`Unknown board “${command.scope}”.`)

  // Snapshot each scope once, before its first mutation this utterance
  const ensureSnapshot = (): { board: BoardFile; assets: Array<{ name: string; base64: string }> } => {
    let snap = snapshots.get(scope.scope)
    if (!snap) {
      snap = { board: loadBoard(scope.scope), assets: [] }
      snapshots.set(scope.scope, snap)
    }
    return snap
  }

  switch (command.action) {
    case 'add': {
      const title = command.title?.trim()
      if (!title) throw new Error('No title for the new todo.')
      ensureSnapshot()
      addCard(scope.scope, title, 'todo', command.text ?? undefined)
      return { summary: `Added “${title}” to ${scope.name} → Todo`, mutated: true }
    }
    case 'move': {
      const board = loadBoard(scope.scope)
      const card = command.cardId ? board.cards[command.cardId] : undefined
      if (!card) throw new Error('That card no longer exists.')
      const to = command.to as TodoStatus
      if (!TODO_STATUSES.includes(to)) throw new Error(`Unknown column “${command.to}”.`)
      if (statusOf(board, card.id) === to)
        return { summary: `“${card.title}” is already in ${TODO_STATUS_LABELS[to]}.`, mutated: false }
      ensureSnapshot()
      moveCard(scope.scope, card.id, to)
      return { summary: `Moved “${card.title}” to ${TODO_STATUS_LABELS[to]}`, mutated: true }
    }
    case 'edit': {
      const board = loadBoard(scope.scope)
      const card = command.cardId ? board.cards[command.cardId] : undefined
      if (!card) throw new Error('That card no longer exists.')
      ensureSnapshot()
      updateCard({
        scopeDir: scope.scope,
        cardId: card.id,
        title: command.title?.trim() || card.title,
        text: command.text ?? card.text ?? '',
        addImages: [],
        removeImages: []
      })
      return { summary: `Updated “${card.title}”`, mutated: true }
    }
    case 'delete': {
      const board = loadBoard(scope.scope)
      const card = command.cardId ? board.cards[command.cardId] : undefined
      if (!card) throw new Error('That card no longer exists.')
      // Deleting removes image files — capture them so Undo restores fully
      const snap = ensureSnapshot()
      for (const name of card.images ?? []) {
        const dataUrl = readAsset(scope.scope, name)
        if (dataUrl) snap.assets.push({ name, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
      }
      deleteCard(scope.scope, card.id)
      return { summary: `Deleted “${card.title}”`, mutated: true }
    }
  }
}

function undo(): void {
  if (!undoState) return
  for (const [scopeDir, snap] of undoState) {
    restoreAssets(scopeDir, snap.assets)
    restoreBoard(scopeDir, snap.board)
  }
  undoState = null
  phase = 'result'
  pushHud({ phase: 'result', summary: 'Undone', undoable: false })
  hideHudAfter(1500)
}

// ---------- wiring ----------

/** Register (or re-register) the global capture hotkey. Error string or null. */
export function updateTodoHotkey(accelerator: string | undefined): string | null {
  const accel = accelerator?.trim() || DEFAULT_TODO_HOTKEY
  if (accel === registeredHotkey) return null
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = null
  let ok = false
  try {
    ok = globalShortcut.register(accel, onHotkey)
  } catch {
    ok = false
  }
  if (!ok) return `Could not register the voice hotkey “${accel}” — it may be taken by another app.`
  registeredHotkey = accel
  return null
}

export function initTodoVoice(win: BrowserWindow, hotkey: string | undefined): void {
  mainWin = win
  ipcMain.on('hud:action', (_e, action: string) => {
    if (action === 'stop' && phase === 'capturing') onHotkey()
    else if (action === 'undo') undo()
    else if (action === 'dismiss') {
      phase = 'idle'
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = null
      hud?.hide()
    }
    // Hovering pins the HUD open to read a long result; leaving re-arms a
    // short dismiss
    else if (action === 'hover-in') {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = null
    } else if (action === 'hover-out') {
      if (phase === 'result' || phase === 'idle') hideHudAfter(2500)
    }
  })
  // The HUD asks to fit its content — grow downward from the fixed top edge
  ipcMain.on('hud:resize', (_e, height: number) => {
    if (!hud || hud.isDestroyed() || typeof height !== 'number') return
    const clamped = Math.round(Math.min(HUD_MAX_HEIGHT, Math.max(HUD_MIN_HEIGHT, height)))
    const [x, y] = hud.getPosition()
    hud.setBounds({ x, y, width: HUD_WIDTH, height: clamped })
  })
  const err = updateTodoHotkey(hotkey)
  if (err) safeSend(mainWin, 'app:toast', err)
}

export function disposeTodoVoice(): void {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = null
  closeHud()
}
