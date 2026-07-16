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

export interface BridgeOptions extends StoreOptions {
  /** Which agent this instance serves — routes handoff/inbox. */
  agent: AgentName
  bridgeRoot?: string
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
        '(titles collide — pick the best match, usually the most recent). Follow up with get_session for content.',
      inputSchema: {
        query: z.string().describe('Topic or title words, e.g. "how to make an apple"'),
        source: z.enum(['claude', 'codex']).optional().describe('Restrict to one tool'),
        project: z.string().optional().describe('Restrict to a project directory name'),
        limit: z.number().int().min(1).max(20).optional()
      }
    },
    async (args) => {
      audit('search_sessions', args)
      return asText(searchSessions(args.query, { ...storeOpts, ...args }))
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

  return server
}
