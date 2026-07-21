import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  emptyArchive,
  emptyBoard,
  TODO_STATUSES,
  type ArchiveFile,
  type BoardFile,
  type TodoStatus
} from './todos'

/**
 * Todo store (SPEC-TODOS.md §4): ~/.chewo/todos/<scope>/board.json + assets/.
 * Plain functions over disk with no Electron dependency — the app's IPC
 * handlers (via src/main/todos.ts) and the out-of-process context-bridge MCP
 * server (T3) both call these same functions.
 *
 * Every mutation persists, then notifies the commit listener; main registers
 * one that pushes 'todos:changed' so the renderer re-renders from main's
 * state (voice commands and MCP tools mutate outside the renderer, so pushed
 * state is the only source of truth).
 */

let root = join(homedir(), '.chewo', 'todos')

/** Test seam — production always uses ~/.chewo/todos. */
export function setTodosRoot(path: string): void {
  root = path
}

const todosRoot = (): string => root

/** Interpreter runs (`claude -p`) get this as cwd so their sessions are
 * identifiable — the sidebar filters anything under ~/.chewo out. */
export function todosRootPath(): string {
  mkdirSync(root, { recursive: true })
  return root
}

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

let onCommit: ((scopeDir: string) => void) | null = null

/** Main registers the renderer push here; other processes leave it unset. */
export function setCommitListener(fn: (scopeDir: string) => void): void {
  onCommit = fn
}

function commit(scopeDir: string, board: BoardFile): BoardFile {
  saveBoard(scopeDir, board)
  onCommit?.(scopeDir)
  return board
}

export function addCard(
  scopeDir: string,
  title: string,
  status: TodoStatus = 'todo',
  text?: string
): BoardFile {
  const board = loadBoard(scopeDir)
  const trimmed = title.trim()
  if (!trimmed) return board
  const now = new Date().toISOString()
  const card = {
    id: randomUUID(),
    title: trimmed,
    text: text?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  }
  board.cards[card.id] = card
  board.columns[status].unshift(card.id)
  return commit(scopeDir, board)
}

/** Undo for voice commands: write a snapshot back verbatim (SPEC-TODOS §6). */
export function restoreBoard(scopeDir: string, board: BoardFile): BoardFile {
  return commit(scopeDir, board)
}

/** Undoing a voice delete also brings back the card's image files. */
export function restoreAssets(
  scopeDir: string,
  files: Array<{ name: string; base64: string }>
): void {
  const assetsDir = join(scopePath(scopeDir), 'assets')
  for (const file of files) {
    if (!/^[a-z0-9-]+\.png$/.test(file.name)) continue
    writeFileSync(join(assetsDir, file.name), Buffer.from(file.base64, 'base64'))
  }
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

/** Absolute assets path — the renderer needs it to name images in a prompt. */
export function assetsDir(scopeDir: string): string {
  return join(scopePath(scopeDir), 'assets')
}

/**
 * Drag-to-run (§10): the card moves to the top of In Progress and remembers
 * when it was last launched. One store call so a run can't half-apply.
 */
export function markCardRun(scopeDir: string, cardId: string): BoardFile {
  const board = loadBoard(scopeDir)
  const card = board.cards[cardId]
  if (!card) return board
  for (const status of TODO_STATUSES) {
    board.columns[status] = board.columns[status].filter((id) => id !== cardId)
  }
  board.columns['in-progress'].unshift(cardId)
  const now = new Date().toISOString()
  card.lastRunAt = now
  card.updatedAt = now
  return commit(scopeDir, board)
}

// ---------- archive (T4) ----------

export function loadArchive(scopeDir: string): ArchiveFile {
  const dir = scopePath(scopeDir)
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'archive.json'), 'utf8')) as ArchiveFile
    return { version: 1, cards: (parsed.cards ?? []).filter((c) => c?.id && c.title) }
  } catch {
    return emptyArchive()
  }
}

function saveArchive(scopeDir: string, archive: ArchiveFile): void {
  writeFileSync(join(scopePath(scopeDir), 'archive.json'), JSON.stringify(archive, null, 2))
}

/**
 * Retire the Done column into archive.json. Images stay on disk so a restore
 * is lossless — an archived card is out of the way, not gone.
 */
export function archiveDone(scopeDir: string): BoardFile {
  const board = loadBoard(scopeDir)
  if (board.columns.done.length === 0) return board
  const archive = loadArchive(scopeDir)
  const archivedAt = new Date().toISOString()
  for (const id of board.columns.done) {
    const card = board.cards[id]
    if (!card) continue
    archive.cards.unshift({ ...card, archivedAt })
    delete board.cards[id]
  }
  board.columns.done = []
  saveArchive(scopeDir, archive)
  return commit(scopeDir, board)
}

/** Archived cards come back to the top of Todo — where you'd act on them. */
export function restoreArchived(scopeDir: string, cardId: string): BoardFile {
  const archive = loadArchive(scopeDir)
  const card = archive.cards.find((c) => c.id === cardId)
  if (!card) return loadBoard(scopeDir)
  archive.cards = archive.cards.filter((c) => c.id !== cardId)
  const board = loadBoard(scopeDir)
  const { archivedAt: _archivedAt, ...restored } = card
  board.cards[card.id] = { ...restored, updatedAt: new Date().toISOString() }
  board.columns.todo.unshift(card.id)
  saveArchive(scopeDir, archive)
  return commit(scopeDir, board)
}

/** The only destructive path left: an explicit delete from the archive. */
export function deleteArchived(scopeDir: string, cardId: string): ArchiveFile {
  const archive = loadArchive(scopeDir)
  const card = archive.cards.find((c) => c.id === cardId)
  if (!card) return archive
  const assetsDir = join(scopePath(scopeDir), 'assets')
  for (const name of card.images ?? []) rmSync(join(assetsDir, name), { force: true })
  archive.cards = archive.cards.filter((c) => c.id !== cardId)
  saveArchive(scopeDir, archive)
  onCommit?.(scopeDir)
  return archive
}

export function emptyArchiveFile(scopeDir: string): ArchiveFile {
  const archive = loadArchive(scopeDir)
  const assetsDir = join(scopePath(scopeDir), 'assets')
  for (const card of archive.cards) {
    for (const name of card.images ?? []) rmSync(join(assetsDir, name), { force: true })
  }
  const emptied = emptyArchive()
  saveArchive(scopeDir, emptied)
  onCommit?.(scopeDir)
  return emptied
}

/**
 * Remove a scope's board, archive, and images (T4 project-removal cleanup).
 * Only ever called with the user's explicit consent at removal time — the
 * default is to keep the files, since the folder may come back.
 */
export function deleteScope(scopeDir: string): void {
  rmSync(scopePath(scopeDir), { recursive: true, force: true })
  onCommit?.(scopeDir)
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
