import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { auditLog, checkInbox, writeHandoff, DEFAULT_BRIDGE_ROOT, type AgentName } from './inbox'
import {
  digestSession,
  fullSessionPage,
  getSessionById,
  listRecentSessions,
  searchSessions,
  tailSession,
  type StoreOptions
} from './store'
import { STATUS_HINT, todoAdd, todoDelete, todoMove, todoUpdate, todosList } from './todos'
import { TODO_STATUSES } from '../../../src/shared/todos'

export interface BridgeOptions extends StoreOptions {
  /** Which agent this instance serves — routes handoff/inbox. */
  agent: AgentName
  bridgeRoot?: string
  /** The CLI session's cwd — boosts (never filters) current-project search results. */
  cwd?: string
}

const asText = (value: unknown): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

export function buildServer(opts: BridgeOptions): McpServer {
  const bridgeRoot = opts.bridgeRoot ?? DEFAULT_BRIDGE_ROOT
  const storeOpts: StoreOptions = { claudeRoot: opts.claudeRoot, codexRoot: opts.codexRoot }
  const audit = (tool: string, args: unknown): void => auditLog(opts.agent, tool, args, bridgeRoot)

  const server = new McpServer({ name: 'context-bridge', version: '0.1.0' })

  server.registerTool(
    'search_sessions',
    {
      description:
        'Search past Claude Code AND Codex CLI conversations by topic. Returns ranked candidates ' +
        '(titles collide — pick the best match, usually the most recent). Sessions from the current ' +
        'working project rank first, but ALL projects are searched — when the user names another ' +
        'project ("from my abc project…"), pass it as the project parameter. ' +
        'Follow up with get_session for content.',
      inputSchema: {
        query: z.string().describe('Topic or title words, e.g. "how to make an apple"'),
        source: z.enum(['claude', 'codex']).optional().describe('Restrict to one tool'),
        project: z.string().optional().describe('Restrict to a project directory name'),
        limit: z.number().int().min(1).max(20).optional()
      }
    },
    async (args) => {
      audit('search_sessions', args)
      return asText(searchSessions(args.query, { ...storeOpts, ...args, boostPath: opts.cwd }))
    }
  )

  server.registerTool(
    'get_session',
    {
      description:
        'Read a past session by id (from search_sessions/list_recent_sessions). ' +
        'mode "summary" (default): compact digest. "tail": last messages. "full": complete transcript, paginated.',
      inputSchema: {
        id: z.string().describe('Session id'),
        mode: z.enum(['summary', 'full', 'tail']).optional(),
        page: z.number().int().min(1).optional().describe('Page number for mode "full"')
      }
    },
    async (args) => {
      audit('get_session', args)
      const result = getSessionById(args.id, storeOpts)
      if (!result) return asText(`No session found with id ${args.id}. Use search_sessions to find valid ids.`)
      const mode = args.mode ?? 'summary'
      if (mode === 'tail') return asText(tailSession(result))
      if (mode === 'full') return asText(fullSessionPage(result, args.page ?? 1).text)
      return asText(digestSession(result))
    }
  )

  server.registerTool(
    'list_recent_sessions',
    {
      description: 'List the most recent Claude Code and Codex sessions (both tools, newest first).',
      inputSchema: {
        source: z.enum(['claude', 'codex']).optional(),
        project: z.string().optional().describe('Restrict to a project directory name'),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    async (args) => {
      audit('list_recent_sessions', args)
      return asText(listRecentSessions({ ...storeOpts, ...args }))
    }
  )

  server.registerTool(
    'handoff',
    {
      description:
        `Hand context to the OTHER agent (${opts.agent === 'claude' ? 'codex' : 'claude'}). ` +
        'Writes a note to its inbox; it reads the note with check_inbox and can get_session your session for depth. ' +
        'Include your current session id so the peer can pull full context.',
      inputSchema: {
        to: z.enum(['claude', 'codex']).describe('Target agent'),
        note: z.string().describe('What the peer needs to know — decisions, constraints, next steps'),
        session_id: z.string().optional().describe('Source session id for deeper context')
      }
    },
    async (args) => {
      audit('handoff', { ...args, note: args.note.slice(0, 200) })
      const handoff = writeHandoff(
        { from: opts.agent, to: args.to, note: args.note, sessionId: args.session_id },
        bridgeRoot
      )
      return asText({ delivered: true, to: handoff.to, createdAt: handoff.createdAt })
    }
  )

  server.registerTool(
    'check_inbox',
    {
      description: `Read pending handoff notes other agents left for me (${opts.agent}). Clears the inbox.`,
      inputSchema: {}
    },
    async () => {
      audit('check_inbox', {})
      const items = checkInbox(opts.agent, bridgeRoot)
      if (items.length === 0) return asText('Inbox empty — no pending handoffs.')
      return asText(items)
    }
  )

  // ---------- todo board (SPEC-TODOS.md §9) ----------

  const todoCtx = { cwd: opts.cwd }
  const scopeArg = z
    .string()
    .optional()
    .describe('Board: a project name, or "General". Defaults to this session\'s project')
  const statusArg = z.enum(TODO_STATUSES as [string, ...string[]])

  /** Store errors are the agent's fault to fix (bad scope/id) — surface the
   * message as tool output rather than a protocol error. */
  const run = (tool: string, args: unknown, fn: () => unknown) => {
    audit(tool, args)
    try {
      return asText(fn())
    } catch (err) {
      return asText(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  server.registerTool(
    'todos_list',
    {
      description:
        "Read the user's Kanban todo board — the four columns and every card with its id. " +
        'Call this before moving, editing, or deleting so you have real card ids.',
      inputSchema: {
        scope: scopeArg,
        all: z.boolean().optional().describe('Return every board instead of just one')
      }
    },
    async (args) => run('todos_list', args, () => todosList(args, todoCtx))
  )

  server.registerTool(
    'todo_add',
    {
      description:
        "Add a card to the user's todo board — use it when work surfaces that you are not doing " +
        'now (a follow-up, a flaky test, a deferred cleanup) so it is not lost. ' +
        'Keep the title a short imperative; put detail in text.',
      inputSchema: {
        title: z.string().describe('Short imperative, e.g. "Fix flaky auth test"'),
        text: z.string().optional().describe('Detail: context, links, repro steps'),
        status: statusArg.optional().describe(`Column — one of ${STATUS_HINT}. Defaults to "todo"`),
        scope: scopeArg
      }
    },
    async (args) => run('todo_add', args, () => todoAdd(args as never, todoCtx))
  )

  server.registerTool(
    'todo_move',
    {
      description:
        'Move a card to another column — e.g. mark work done once you finish it. ' +
        'The card lands at the top of the target column.',
      inputSchema: {
        cardId: z.string().describe('Card id from todos_list'),
        to: statusArg.describe(`Target column — one of ${STATUS_HINT}`),
        scope: scopeArg
      }
    },
    async (args) => run('todo_move', args, () => todoMove(args as never, todoCtx))
  )

  server.registerTool(
    'todo_update',
    {
      description: 'Edit a card\'s title and/or text. Omitted fields keep their current value.',
      inputSchema: {
        cardId: z.string().describe('Card id from todos_list'),
        title: z.string().optional(),
        text: z.string().optional().describe('Pass "" to clear the body'),
        scope: scopeArg
      }
    },
    async (args) => run('todo_update', args, () => todoUpdate(args, todoCtx))
  )

  server.registerTool(
    'todo_delete',
    {
      description:
        'Delete a card and its images. Prefer todo_move to "done" for finished work — ' +
        'delete only when the user asks, or the card was filed in error.',
      inputSchema: { cardId: z.string().describe('Card id from todos_list'), scope: scopeArg }
    },
    async (args) => run('todo_delete', args, () => todoDelete(args, todoCtx))
  )

  return server
}
