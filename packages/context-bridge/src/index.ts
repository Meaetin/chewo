import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server'
import type { AgentName } from './inbox'

function parseAgent(argv: string[]): AgentName {
  const i = argv.indexOf('--agent')
  const value = i >= 0 ? argv[i + 1] : undefined
  if (value === 'claude' || value === 'codex') return value
  // Registered without --agent: handoff routing degrades, history tools still work
  console.error('context-bridge: missing/invalid --agent flag, defaulting to "claude"')
  return 'claude'
}

async function main(): Promise<void> {
  const server = buildServer({ agent: parseAgent(process.argv) })
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error('context-bridge failed to start:', err)
  process.exit(1)
})
