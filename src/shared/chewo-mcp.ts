import type { AgentId } from './agents'

/**
 * Identity and connection state of Chewo's own MCP server — the spine both
 * CLIs query (SPEC.md §4.4). Types only, no node imports: the settings pane
 * renders from these. Filesystem paths live in `mcp-paths.ts`, the server
 * itself in `packages/chewo-mcp`.
 */

/**
 * The name both CLIs register the server under. It is user-visible: tools reach
 * the model as `mcp__chewo__search_sessions`, so changing it invalidates every
 * saved tool permission and every prompt that names a tool.
 */
export const MCP_SERVER_NAME = 'chewo'

/** What the server was called before the rename — removed when we re-register. */
export const LEGACY_MCP_SERVER_NAME = 'context-bridge'

/**
 * - `connected` — registered, and pointed at this build's server bundle
 * - `stale` — registered under our name but running some other copy (the app
 *   moved, or a dev registration outlives the checkout). Reconnect re-points it.
 * - `legacy` — still registered as `context-bridge`; connecting migrates it
 * - `disconnected` — the CLI is installed, we are simply not registered
 * - `cli-missing` — the agent isn't on PATH, so there is nothing to register with
 */
export type McpConnectionState = 'connected' | 'stale' | 'legacy' | 'disconnected' | 'cli-missing'

export interface McpAgentStatus {
  agent: AgentId
  state: McpConnectionState
  /** The command line currently registered, when there is one */
  registered?: string
}

export interface McpStatus {
  /** Absolute path to the server bundle this build would register, if it exists */
  scriptPath: string | null
  agents: McpAgentStatus[]
}

export interface McpConnectResult {
  agent: AgentId
  ok: boolean
  /** CLI stderr on failure — shown verbatim, these messages are actionable */
  error?: string
}
