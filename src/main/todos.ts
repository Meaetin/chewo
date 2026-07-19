import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { emptyBoard, TODO_STATUSES, type BoardFile, type TodoStatus } from '../shared/todos'
import { safeSend } from './safe-send'

/**
 * Todo store (SPEC-TODOS.md §4): ~/.chewo/todos/<scope>/board.json + assets/.
 * Plain functions over disk — IPC handlers call them today, context-bridge
 * MCP tools call the same functions in T3. Every mutation persists, then
 * pushes 'todos:changed' with the scope so the renderer re-renders from
 * main's state (voice commands mutate from main in T2, so pushed state is
 * the only source of truth).
 */

let root = join(homedir(), '.chewo', 'todos')

/** Test seam — production always uses ~/.chewo/todos. */
export function setTodosRoot(path: string): void {
  root = path
}

const todosRoot = (): string => root

/** Scope dirs are generated slugs — reject anything path-like outright. */
function scopePath(scopeDir: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scopeDir)) throw new Error(`bad scope: ${scopeDir}`)
  const dir = join(todosRoot(), scopeDir)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  return dir
}

export function loadBoard(scopeDir: string): BoardFile {
  const dir = scopePath(scopeDir) // bad scopes throw — never silently an empty board
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')) as BoardFile
    // Older/hand-edited files pick up any missing columns
    const board = emptyBoard()
    for (const status of TODO_STATUSES) {
      board.columns[status] = (parsed.columns?.[status] ?? []).filter(
        (id) => parsed.cards?.[id]
      )
    }
    board.cards = parsed.cards ?? {}
    return board
  } catch {
    return emptyBoard()
  }
}

function saveBoard(scopeDir: string, board: BoardFile): void {
  writeFileSync(join(scopePath(scopeDir), 'board.json'), JSON.stringify(board, null, 2))
}

let win: BrowserWindow | null = null

export function setTodosWindow(w: BrowserWindow): void {
  win = w
}

function commit(scopeDir: string, board: BoardFile): BoardFile {
  saveBoard(scopeDir, board)
  safeSend(win, 'todos:changed', { scopeDir })
  return board
}

export function addCard(scopeDir: string, title: string, status: TodoStatus = 'todo'): BoardFile {
  const board = loadBoard(scopeDir)
  const trimmed = title.trim()
  if (!trimmed) return board
  const now = new Date().toISOString()
  const card = { id: randomUUID(), title: trimmed, createdAt: now, updatedAt: now }
  board.cards[card.id] = card
  board.columns[status].unshift(card.id)
  return commit(scopeDir, board)
}

/** Any move — including same-column — drops the card at the top (§5). */
export function moveCard(scopeDir: string, cardId: string, to: TodoStatus): BoardFile {
  const board = loadBoard(scopeDir)
  if (!board.cards[cardId]) return board
  for (const status of TODO_STATUSES) {
    board.columns[status] = board.columns[status].filter((id) => id !== cardId)
  }
  board.columns[to].unshift(cardId)
  board.cards[cardId].updatedAt = new Date().toISOString()
  return commit(scopeDir, board)
}

export interface UpdateCardArgs {
  scopeDir: string
  cardId: string
  title: string
  text: string
  /** Pasted images staged in the modal — base64 PNG payloads */
  addImages: string[]
  /** Existing asset filenames the user removed */
  removeImages: string[]
}

export function updateCard(args: UpdateCardArgs): BoardFile {
  const board = loadBoard(args.scopeDir)
  const card = board.cards[args.cardId]
  if (!card) return board

  const assetsDir = join(scopePath(args.scopeDir), 'assets')
  const kept = (card.images ?? []).filter((name) => !args.removeImages.includes(name))
  for (const name of args.removeImages) {
    if (card.images?.includes(name)) rmSync(join(assetsDir, name), { force: true })
  }
  const added: string[] = []
  for (const data of args.addImages) {
    const name = `${randomUUID()}.png`
    writeFileSync(join(assetsDir, name), Buffer.from(data, 'base64'))
    added.push(name)
  }

  card.title = args.title.trim() || card.title
  card.text = args.text.trim() || undefined
  const images = [...kept, ...added]
  card.images = images.length > 0 ? images : undefined
  card.updatedAt = new Date().toISOString()
  return commit(args.scopeDir, board)
}

export function deleteCard(scopeDir: string, cardId: string): BoardFile {
  const board = loadBoard(scopeDir)
  const card = board.cards[cardId]
  if (!card) return board
  const assetsDir = join(scopePath(scopeDir), 'assets')
  for (const name of card.images ?? []) rmSync(join(assetsDir, name), { force: true })
  for (const status of TODO_STATUSES) {
    board.columns[status] = board.columns[status].filter((id) => id !== cardId)
  }
  delete board.cards[cardId]
  return commit(scopeDir, board)
}

export function clearDone(scopeDir: string): BoardFile {
  const board = loadBoard(scopeDir)
  const assetsDir = join(scopePath(scopeDir), 'assets')
  for (const id of board.columns.done) {
    for (const name of board.cards[id]?.images ?? []) rmSync(join(assetsDir, name), { force: true })
    delete board.cards[id]
  }
  board.columns.done = []
  return commit(scopeDir, board)
}

/**
 * Images render via data URLs — file:// is blocked from the dev server's
 * http origin, and IPC keeps the renderer path-free.
 */
export function readAsset(scopeDir: string, fileName: string): string | null {
  if (!/^[a-z0-9-]+\.png$/.test(fileName)) return null
  try {
    const data = readFileSync(join(scopePath(scopeDir), 'assets', fileName))
    return `data:image/png;base64,${data.toString('base64')}`
  } catch {
    return null
  }
}
