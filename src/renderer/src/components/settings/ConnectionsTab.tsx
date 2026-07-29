import { useCallback, useEffect, useState } from 'react'
import { Link2, Link2Off, RefreshCw } from 'lucide-react'
import { AGENT_IDS, agentDef, type AgentId } from '../../../../shared/agents'
import {
  MCP_SERVER_NAME,
  type McpAgentStatus,
  type McpConnectionState,
  type McpStatus
} from '../../../../shared/chewo-mcp'
import { Button } from '../ui'

/**
 * Connecting Chewo's MCP server to the installed CLIs — the one surface where
 * a registration is ever created.
 *
 * It is opt-in on purpose: connecting writes to the user's global agent config
 * and hands every session read access to their entire history across both
 * tools, which is not something to arrange behind their back on first launch.
 * Once connected, the app repairs the entry itself (moved app, renamed server)
 * without asking again.
 */

const STATE_LABEL: Record<McpConnectionState, string> = {
  connected: 'Connected',
  stale: 'Needs reconnect',
  legacy: 'Older version',
  disconnected: 'Not connected',
  'cli-missing': 'Not installed'
}

const STATE_DETAIL: Record<McpConnectionState, string> = {
  connected: 'New sessions can search this agent’s history and hand off to the other.',
  stale: 'Registered against a different copy of Chewo — reconnect to point it here.',
  legacy: 'Registered under the old name `context-bridge` — reconnect to migrate it.',
  disconnected: 'This agent has no access to Chewo’s shared memory yet.',
  'cli-missing': 'The CLI was not found on your PATH — install it, then reopen this pane.'
}

export function ConnectionsTab(): React.JSX.Element {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState<AgentId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await window.api.mcpStatus())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (agent: AgentId, connect: boolean): Promise<void> => {
    setBusy(agent)
    setError(null)
    const result = connect
      ? await window.api.mcpConnect(agent)
      : await window.api.mcpDisconnect(agent)
    if (!result.ok) setError(result.error ?? 'The CLI refused the change.')
    await refresh()
    setBusy(null)
  }

  const byAgent = new Map<AgentId, McpAgentStatus>(status?.agents.map((a) => [a.agent, a]) ?? [])

  return (
    <div className="settings-connections">
      <p className="settings-connections-callout">
        Connecting registers <code>{MCP_SERVER_NAME}</code> as an MCP server with that CLI. Every
        session it runs can then search <strong>all</strong> of your Claude Code and Codex history,
        read past transcripts, and file to-dos — including from repositories you do not control.
        Disconnect at any time; sessions already open keep the tools until they exit.
      </p>

      <div className="settings-connections-list">
        {AGENT_IDS.map((id) => {
          const agent = byAgent.get(id)
          const state = agent?.state ?? 'disconnected'
          const connected = state === 'connected'
          const missing = state === 'cli-missing'
          const working = busy === id

          return (
            <div key={id} className={`settings-connection-row settings-connection-${state}`}>
              <div className="settings-connection-meta">
                <div className="settings-connection-head">
                  <span className="settings-connection-name">{agentDef(id).label}</span>
                  <span className={`settings-connection-chip settings-connection-chip-${state}`}>
                    {STATE_LABEL[state]}
                  </span>
                </div>
                <p className="settings-connection-detail">{STATE_DETAIL[state]}</p>
                {agent?.registered && (
                  <code className="settings-connection-command">{agent.registered}</code>
                )}
              </div>

              <div className="settings-connection-actions">
                {connected ? (
                  <Button
                    intent="secondary"
                    size="compact"
                    disabled={working}
                    leadingIcon={<Link2Off size={13} strokeWidth={1.75} />}
                    onClick={() => void act(id, false)}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    intent="primary"
                    size="compact"
                    disabled={working || missing || status === null}
                    leadingIcon={
                      state === 'stale' || state === 'legacy' ? (
                        <RefreshCw size={13} strokeWidth={1.75} />
                      ) : (
                        <Link2 size={13} strokeWidth={1.75} />
                      )
                    }
                    onClick={() => void act(id, true)}
                  >
                    {state === 'stale' || state === 'legacy' ? 'Reconnect' : 'Connect'}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {error && <p className="settings-connections-error">{error}</p>}

      {status !== null && status.scriptPath === null && (
        <p className="settings-connections-error">
          This build has no MCP server bundle, so there is nothing to register. Run{' '}
          <code>npm run build:mcp</code> in the checkout.
        </p>
      )}

      {status?.scriptPath && (
        <p className="settings-connections-footnote">
          The server runs from <code>{status.scriptPath}</code>, launched by Chewo&rsquo;s own
          binary — no separate install, and no Node runtime required. Handoff notes and the audit
          log of every tool call live in <code>~/.chewo/mcp</code>.
        </p>
      )}
    </div>
  )
}
