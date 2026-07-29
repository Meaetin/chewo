import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server'
import { auditLog, type AgentName } from './inbox'
import { adoptLegacyMcpRoot } from '../../../src/shared/mcp-paths'

function parseAgent(argv: string[]): AgentName {
  const i = argv.indexOf('--agent')
  const value = i >= 0 ? argv[i + 1] : undefined
  if (value === 'claude' || value === 'codex') return value
  // Registered without --agent: handoff routing degrades, history tools still work
  console.error('chewo mcp: missing/invalid --agent flag, defaulting to "claude"')
  return 'claude'
}

async function main(): Promise<void> {
  const agent = parseAgent(process.argv)
  adoptLegacyMcpRoot()
  // Assumption to verify from audit logs: CLIs spawn MCP servers in the
  // session's cwd. If they don't, the boost silently degrades to neutral.
  const cwd = process.cwd()
  auditLog(agent, 'startup', { cwd })
  const server = buildServer({ agent, cwd })
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error('chewo mcp failed to start:', err)
  process.exit(1)
})
