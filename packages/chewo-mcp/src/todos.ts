import { readScopeIndex, resolveScope, type TodoScope } from '../../../src/shared/todo-scopes'
import {
  addCard,
  deleteCard,
  loadBoard,
  moveCard,
  updateCard
} from '../../../src/shared/todos-store'
import {
  TODO_STATUS_LABELS,
  TODO_STATUSES,
  type BoardFile,
  type TodoStatus
} from '../../../src/shared/todos'

/**
 * Todo tools (SPEC-TODOS.md §9, T3) — thin wrappers over the same store
 * module the app's IPC handlers and voice commands use, so a coding agent
 * filing a todo and Martin dragging a card hit identical code paths. Chewo
 * notices the file change and re-renders the board live.
 *
 * The MCP server runs in the CLI's process, not the app's: scope resolution
 * goes through ~/.chewo/todos/scopes.json (see todo-scopes.ts), and an
 * omitted scope means "the project this session is running in".
 */

export interface TodoToolContext {
  /** The CLI session's cwd — resolves the default scope */
  cwd?: string
}

export class ScopeError extends Error {}

function pickScope(query: string | undefined, ctx: TodoToolContext): TodoScope {
  const scopes = readScopeIndex()
  const scope = resolveScope(scopes, query, ctx.cwd)
  if (!scope) {
    const known = scopes.map((s) => s.name).join(', ')
    throw new ScopeError(`Unknown todo scope "${query}". Known scopes: ${known}.`)
  }
  return scope
}

/** Cards as an agent needs them: id + title + column, newest-first per column. */
function serializeBoard(scope: TodoScope, board: BoardFile): unknown {
  return {
    scope: scope.name,
    scopeDir: scope.dir,
    columns: Object.fromEntries(
      TODO_STATUSES.map((status) => [
        status,
        board.columns[status].map((id) => {
          const card = board.cards[id]
          return { id, title: card.title, text: card.text }
        })
      ])
    )
  }
}

export function todosList(args: { scope?: string; all?: boolean }, ctx: TodoToolContext): unknown {
  if (args.all) {
    return readScopeIndex().map((scope) => serializeBoard(scope, loadBoard(scope.dir)))
  }
  const scope = pickScope(args.scope, ctx)
  return serializeBoard(scope, loadBoard(scope.dir))
}

export function todoAdd(
  args: { title: string; text?: string; status?: TodoStatus; scope?: string },
  ctx: TodoToolContext
): unknown {
  const scope = pickScope(args.scope, ctx)
  const before = loadBoard(scope.dir)
  const status = args.status ?? 'todo'
  const board = addCard(scope.dir, args.title, status, args.text)
  const id = board.columns[status].find((cardId) => !before.cards[cardId])
  if (!id) throw new Error('Card was not created — a title is required.')
  return { added: { id, title: board.cards[id].title }, column: status, scope: scope.name }
}

export function todoMove(
  args: { cardId: string; to: TodoStatus; scope?: string },
  ctx: TodoToolContext
): unknown {
  const scope = pickScope(args.scope, ctx)
  const card = loadBoard(scope.dir).cards[args.cardId]
  if (!card) throw new Error(cardMissing(args.cardId, scope))
  moveCard(scope.dir, args.cardId, args.to)
  return { moved: { id: args.cardId, title: card.title }, to: args.to, scope: scope.name }
}

export function todoUpdate(
  args: { cardId: string; title?: string; text?: string; scope?: string },
  ctx: TodoToolContext
): unknown {
  const scope = pickScope(args.scope, ctx)
  const card = loadBoard(scope.dir).cards[args.cardId]
  if (!card) throw new Error(cardMissing(args.cardId, scope))
  if (args.title === undefined && args.text === undefined) {
    throw new Error('Nothing to update — pass title and/or text.')
  }
  // updateCard replaces both fields; an omitted one keeps its current value.
  // Empty-string text is how a caller clears the body.
  const board = updateCard({
    scopeDir: scope.dir,
    cardId: args.cardId,
    title: args.title ?? card.title,
    text: args.text ?? card.text ?? '',
    addImages: [],
    removeImages: []
  })
  const updated = board.cards[args.cardId]
  return {
    updated: { id: args.cardId, title: updated.title, text: updated.text },
    scope: scope.name
  }
}

export function todoDelete(args: { cardId: string; scope?: string }, ctx: TodoToolContext): unknown {
  const scope = pickScope(args.scope, ctx)
  const card = loadBoard(scope.dir).cards[args.cardId]
  if (!card) throw new Error(cardMissing(args.cardId, scope))
  deleteCard(scope.dir, args.cardId)
  return { deleted: { id: args.cardId, title: card.title }, scope: scope.name }
}

/** Wrong-board mistakes are the likely cause — say where we looked. */
function cardMissing(cardId: string, scope: TodoScope): string {
  return `No card ${cardId} on the ${scope.name} board. Call todos_list to see current ids.`
}

export const STATUS_HINT = TODO_STATUSES.map((s) => `"${s}" (${TODO_STATUS_LABELS[s]})`).join(', ')
