import { describe, expect, test } from 'vitest'
import {
  buildAddCommand,
  buildRemoveCommand,
  entryFromClaudeConfig,
  entryFromCodexToml,
  isCurrent
} from '../src/main/mcp-server'
import { LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME } from '../src/shared/chewo-mcp'

/**
 * Registering Chewo's own MCP server. The round-trip cases matter most: we
 * write through the CLIs and read back from their config files, so a drift
 * between the two shows up as a permanently "stale" pane and a Connect button
 * that appears to do nothing.
 */

const EXEC = '/Applications/Chewo.app/Contents/MacOS/Chewo'
const SCRIPT = '/Applications/Chewo.app/Contents/Resources/bin/chewo-mcp.cjs'

describe('add/remove commands', () => {
  test('claude registers at user scope, as node-mode Chewo', () => {
    const cmd = buildAddCommand('claude', EXEC, SCRIPT)
    expect(cmd).toBe(
      `claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 chewo -- '${EXEC}' '${SCRIPT}' --agent claude`
    )
  })

  test('codex spells the same thing its own way', () => {
    expect(buildAddCommand('codex', EXEC, SCRIPT)).toBe(
      `codex mcp add --env ELECTRON_RUN_AS_NODE=1 chewo -- '${EXEC}' '${SCRIPT}' --agent codex`
    )
  })

  test('a relocated app with spaces in its path stays one argument', () => {
    const spaced = '/Users/x/My Apps/Chewo.app/Contents/MacOS/Chewo'
    expect(buildAddCommand('claude', spaced, SCRIPT)).toContain(`'${spaced}'`)
  })

  test('remove targets the same scope it was added at', () => {
    expect(buildRemoveCommand('claude', LEGACY_MCP_SERVER_NAME)).toBe(
      "claude mcp remove --scope user 'context-bridge'"
    )
    expect(buildRemoveCommand('codex', MCP_SERVER_NAME)).toBe("codex mcp remove 'chewo'")
  })
})

describe('reading back what is registered', () => {
  const claudeConfig = JSON.stringify({
    numStartups: 12,
    mcpServers: {
      chewo: { command: EXEC, args: [SCRIPT, '--agent', 'claude'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      other: { type: 'http', url: 'https://example.com/mcp' }
    }
  })

  const codexConfig = [
    'model = "gpt-5.6"',
    '',
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = "${EXEC}"`,
    `args = ["${SCRIPT}", "--agent", "codex"]`,
    '',
    '[mcp_servers.chewo.env]',
    'ELECTRON_RUN_AS_NODE = "1"',
    '',
    '[hooks.state]',
    'enabled = false'
  ].join('\n')

  test('claude: user-scope entry, command and args intact', () => {
    expect(entryFromClaudeConfig(claudeConfig, MCP_SERVER_NAME)).toEqual({
      command: EXEC,
      args: [SCRIPT, '--agent', 'claude']
    })
  })

  test('claude: an http server has no command — not something we could have written', () => {
    expect(entryFromClaudeConfig(claudeConfig, 'other')).toBeNull()
  })

  test('claude: absent name, and a corrupt config, both read as not registered', () => {
    expect(entryFromClaudeConfig(claudeConfig, LEGACY_MCP_SERVER_NAME)).toBeNull()
    expect(entryFromClaudeConfig('{ not json', MCP_SERVER_NAME)).toBeNull()
  })

  test('codex: the entry survives its own env subsection and the next section', () => {
    expect(entryFromCodexToml(codexConfig, MCP_SERVER_NAME)).toEqual({
      command: EXEC,
      args: [SCRIPT, '--agent', 'codex']
    })
    expect(entryFromCodexToml(codexConfig, LEGACY_MCP_SERVER_NAME)).toBeNull()
  })
})

describe('isCurrent — the connected/stale split', () => {
  const entry = { command: EXEC, args: [SCRIPT, '--agent', 'claude'] }

  test('same binary and same bundle is connected', () => {
    expect(isCurrent(entry, EXEC, SCRIPT)).toBe(true)
  })

  test('an app that moved is stale, not connected', () => {
    expect(isCurrent(entry, '/Users/x/Desktop/Chewo.app/Contents/MacOS/Chewo', SCRIPT)).toBe(false)
  })

  test('a dev registration is stale once the packaged app looks at it', () => {
    const dev = {
      command: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      args: ['/repo/packages/chewo-mcp/dist/index.cjs', '--agent', 'claude']
    }
    expect(isCurrent(dev, EXEC, SCRIPT)).toBe(false)
  })

  test('no bundle in this build means nothing can be current', () => {
    expect(isCurrent(entry, EXEC, null)).toBe(false)
  })
})
