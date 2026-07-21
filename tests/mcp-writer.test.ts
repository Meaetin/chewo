import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addMcpToProjectFile,
  buildClaudeMcpAddCommand,
  buildCodexMcpAddCommand
} from '../src/main/mcp-writer'
import { shellQuote } from '../src/shared/shell'
import { parseCodexMcp } from '../src/shared/capabilities/scan'
import type { McpRef } from '../src/shared/capabilities/types'

const stdioRef: McpRef = {
  name: 'context-bridge',
  tool: 'claude',
  scope: 'user',
  command: 'node /p/index.cjs --agent claude',
  raw: { command: 'node', args: ['/p/index.cjs', '--agent', 'claude'] },
  envKeys: ['API_KEY']
}

const urlRef: McpRef = {
  name: 'sentry',
  tool: 'claude',
  scope: 'user',
  command: 'https://mcp.sentry.dev/mcp',
  raw: { url: 'https://mcp.sentry.dev/mcp' }
}

describe('command builders', () => {
  test('claude stdio add with quoting, no env ever', () => {
    const cmd = buildClaudeMcpAddCommand(stdioRef)!
    expect(cmd).toBe("claude mcp add --scope user 'context-bridge' -- 'node' '/p/index.cjs' '--agent' 'claude'")
    expect(cmd).not.toContain('API_KEY')
  })

  test('claude http add uses transport flag', () => {
    expect(buildClaudeMcpAddCommand(urlRef)).toBe(
      "claude mcp add --scope user --transport http 'sentry' 'https://mcp.sentry.dev/mcp'"
    )
  })

  test('codex add is stdio-only; url refs rejected', () => {
    expect(buildCodexMcpAddCommand(stdioRef)).toBe(
      "codex mcp add 'context-bridge' -- 'node' '/p/index.cjs' '--agent' 'claude'"
    )
    expect(buildCodexMcpAddCommand(urlRef)).toBeNull()
  })

  test('shellQuote survives embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe('addMcpToProjectFile', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-test-'))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test('creates .mcp.json, merges without disturbing other keys, strips env', () => {
    writeFileSync(
      join(tmp, '.mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'x' } }, otherTopLevel: true })
    )
    expect(addMcpToProjectFile(stdioRef, tmp)).toBe('copied')
    const cfg = JSON.parse(readFileSync(join(tmp, '.mcp.json'), 'utf8'))
    expect(cfg.otherTopLevel).toBe(true)
    expect(cfg.mcpServers.existing).toEqual({ command: 'x' })
    expect(cfg.mcpServers['context-bridge']).toEqual({
      command: 'node',
      args: ['/p/index.cjs', '--agent', 'claude']
    })
    expect(JSON.stringify(cfg)).not.toContain('API_KEY')
  })

  test('exists without overwrite; url entries get http type', () => {
    expect(addMcpToProjectFile(urlRef, tmp)).toBe('copied')
    expect(addMcpToProjectFile(urlRef, tmp)).toBe('exists')
    const cfg = JSON.parse(readFileSync(join(tmp, '.mcp.json'), 'utf8'))
    expect(cfg.mcpServers.sentry).toEqual({ type: 'http', url: 'https://mcp.sentry.dev/mcp' })
  })
})

describe('parseCodexMcp env sections', () => {
  test('captures env key NAMES only, never values', () => {
    const toml = [
      '[mcp_servers.node_repl]',
      'command = "node"',
      '[mcp_servers.node_repl.env]',
      'SECRET_TOKEN = "super-secret-value"',
      'OTHER_KEY = "x"',
      '[features]'
    ].join('\n')
    const refs = parseCodexMcp(toml)
    expect(refs).toHaveLength(1)
    expect(refs[0].envKeys).toEqual(['SECRET_TOKEN', 'OTHER_KEY'])
    expect(JSON.stringify(refs)).not.toContain('super-secret-value')
  })
})
