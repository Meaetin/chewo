/**
 * Todo board model (SPEC-TODOS.md §4). Boards live outside the app at
 * ~/.chewo/todos/<scope>/board.json with pasted images in a sibling assets/
 * folder. Column order is the data: each column is an ordered id array,
 * index 0 = top, and a card's status is derived from which column holds it.
 */

export type TodoStatus = 'blocked' | 'todo' | 'in-progress' | 'done'

export const TODO_STATUSES: TodoStatus[] = ['blocked', 'todo', 'in-progress', 'done']

export const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
  blocked: 'Blocked',
  todo: 'Todo',
  'in-progress': 'In Progress',
  done: 'Done'
}

export interface TodoCard {
  id: string
  title: string
  text?: string
  /** Filenames under the scope's assets/ folder */
  images?: string[]
  createdAt: string
  updatedAt: string
  /** Last drag-to-run (§10); additive, file version stays 1 */
  lastRunAt?: string
}

/**
 * The prompt a dropped card hands to Claude (SPEC-TODOS §10.2). Minimal and
 * unframed on purpose — it should read as if Martin typed it, not as if a
 * machine assembled it. Images ride as absolute paths because the card's
 * PNGs are already real files and Claude Code reads paths it finds in a
 * prompt.
 */
export function composeCardPrompt(card: TodoCard, assetsDir: string): string {
  const parts = [`Todo: ${card.title.trim()}`]
  const text = card.text?.trim()
  if (text) parts.push(text)
  if (card.images?.length) {
    parts.push(
      ['Reference images (read these files):', ...card.images.map((n) => `- ${assetsDir}/${n}`)].join(
        '\n'
      )
    )
  }
  return parts.join('\n\n')
}

export interface BoardFile {
  version: 1
  columns: Record<TodoStatus, string[]>
  cards: Record<string, TodoCard>
}

/**
 * A card retired from Done (T4). "Archive done" replaces the old destructive
 * clear: cards leave board.json for archive.json in the same folder, keeping
 * their images, and can be restored to Todo. Nothing on this board is ever
 * lost to a single click — deleting an archived card is a second, explicit act.
 */
export interface ArchivedCard extends TodoCard {
  archivedAt: string
}

export interface ArchiveFile {
  version: 1
  /** Newest first */
  cards: ArchivedCard[]
}

export const emptyArchive = (): ArchiveFile => ({ version: 1, cards: [] })

export const emptyBoard = (): BoardFile => ({
  version: 1,
  columns: { blocked: [], todo: [], 'in-progress': [], done: [] },
  cards: {}
})

/** The General board's directory name; project boards get p-<slug>-<hash8>. */
export const GENERAL_SCOPE = 'general'

const djb2Hex = (input: string): string => {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Stable per-project board directory derived from the project path, with a
 * name slug so the folders are recognizable when browsing ~/.chewo/todos.
 */
export function projectScopeDir(name: string, path: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'project'
  return `p-${slug}-${djb2Hex(path)}`
}

/**
 * State pushed from main to the voice HUD (SPEC-TODOS §6). Pushes are
 * partial — the HUD merges defined fields over its last state, so a
 * level-only tick never wipes the transcript.
 */
export interface HudState {
  phase: 'capturing' | 'thinking' | 'result' | 'error'
  confirmed?: string
  tail?: string
  /** Mic energy 0…1 */
  level?: number
  /** Model still loading — capture is buffering (capture-before-ready) */
  loading?: boolean
  /** The full utterance as finally transcribed — the live transcript lags
   * seconds behind speech, so this is what "you said" once you stop */
  finalText?: string
  summary?: string
  message?: string
  undoable?: boolean
}

/** Which column holds a card. */
export function statusOf(board: BoardFile, cardId: string): TodoStatus | null {
  for (const status of TODO_STATUSES) {
    if (board.columns[status].includes(cardId)) return status
  }
  return null
}
