import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { AgentId } from '../shared/agents'
import { parseCodexMcp } from '../shared/capabilities/scan'
import {
  LEGACY_MCP_SERVER_NAME,
  MCP_SERVER_NAME,
  type McpAgentStatus,
  type McpConnectResult,
  type McpStatus
} from '../shared/chewo-mcp'
import { shellQuote } from '../shared/shell'

const execFileAsync = promisify(execFile)

/**
 * Registering Chewo's own MCP server with the CLIs (SPEC.md §4.4).
 *
 * Three rules this module exists to hold:
 *
 * 1. **We never hand-write a CLI's config.** Reads parse `~/.claude.json` and
 *    `~/.codex/config.toml` directly (cheap, and `claude mcp list` does network
 *    health checks); every write shells out to `claude mcp add|remove` /
 *    `codex mcp add|remove`, same doctrine as `mcp-writer.ts`.
 * 2. **No Node on PATH is assumed.** Claude Code ships as a native binary and
 *    Codex is Rust, so a user can have both and no `node`. The registered
 *    command is Chewo's own Electron binary with `ELECTRON_RUN_AS_NODE=1`,
 *    which runs the bundle as plain Node with zero external runtime.
 * 3. **Adding a registration needs consent, repairing one does not.** A fresh
 *    connect only ever happens from Settings → Connections. `reconcile()` at
 *    launch re-points a registration the user already made when the app moves
 *    (or migrates the pre-rename `context-bridge` entry) — it never adds one.
 */

const CLAUDE_CONFIG = join(homedir(), '.claude.json')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')

export interface RegisteredEntry {
  command: string
  args: string[]
}

/**
 * The server bundle this build would register. Packaged it is an
 * extraResource; in dev it is the workspace build product, so `npm run dev`
 * registers the checkout and a `build:mcp` picks up on the next CLI session.
 */
export function mcpScriptPath(): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'chewo-mcp.cjs')
    : join(app.getAppPath(), 'packages', 'chewo-mcp', 'dist', 'index.cjs')
  return existsSync(path) ? path : null
}

// ---------- reading what is registered ----------

/** User-scope servers live at the top level of ~/.claude.json. */
export function entryFromClaudeConfig(raw: string, name: string): RegisteredEntry | null {
  try {
    const cfg = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>
    }
    const entry = cfg.mcpServers?.[name]
    if (!entry?.command) return null
    return { command: entry.command, args: entry.args ?? [] }
  } catch {
    return null
  }
}

/** Same TOML reader the capabilities scanner uses — one parser for Codex config. */
export function entryFromCodexToml(toml: string, name: string): RegisteredEntry | null {
  const raw = parseCodexMcp(toml).find((r) => r.name === name)?.raw
  if (!raw?.command) return null
  return { command: raw.command, args: raw.args ?? [] }
}

function readEntry(agent: AgentId, name: string): RegisteredEntry | null {
  try {
    const config = agent === 'claude' ? CLAUDE_CONFIG : CODEX_CONFIG
    const raw = readFileSync(config, 'utf8')
    return agent === 'claude' ? entryFromClaudeConfig(raw, name) : entryFromCodexToml(raw, name)
  } catch {
    return null // no config file yet — nothing is registered
  }
}

/** Is this registration pointed at the bundle this build would register? */
export function isCurrent(
  entry: RegisteredEntry,
  execPath: string,
  scriptPath: string | null
): boolean {
  return scriptPath !== null && entry.command === execPath && entry.args.includes(scriptPath)
}

const describe = (entry: RegisteredEntry): string => [entry.command, ...entry.args].join(' ')

// ---------- running the CLIs ----------

/** Login shell so PATH resolves the CLIs in a packaged app (no inherited env). */
async function runLoginShell(command: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-ilc', command], {
      timeout: 20_000
    })
    return { ok: true, output: (stdout + stderr).trim() }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: (e.stderr || e.stdout || e.message || 'command failed').trim() }
  }
}

/** Which CLIs exist, in one shell round trip — a login zsh costs ~200ms. */
async function installedClis(): Promise<Set<AgentId>> {
  const run = await runLoginShell('command -v claude; command -v codex')
  const found = new Set<AgentId>()
  if (!run.ok) return found
  for (const line of run.output.split('\n')) {
    const bin = line.trim().split('/').pop()
    if (bin === 'claude') found.add('claude')
    if (bin === 'codex') found.add('codex')
  }
  return found
}

/**
 * `ELECTRON_RUN_AS_NODE=1` plus our own binary is what makes this shippable:
 * the CLI launches Chewo as a plain Node runtime, so the server needs no
 * `node` on PATH and no separate install. `mcp add` overwrites an existing
 * entry of the same name, so this doubles as the repair command.
 *
 * The server NAME MUST COME FIRST, before the env flag. Claude's `-e` is a
 * variadic option, so `-e KEY=1 chewo` swallows the name as a second env var
 * and fails with "Invalid environment variable format: chewo". Both CLIs
 * accept name-then-flags, so both are spelled that way.
 */
export function buildAddCommand(agent: AgentId, execPath: string, scriptPath: string): string {
  const target = `${shellQuote(execPath)} ${shellQuote(scriptPath)} --agent ${agent}`
  return agent === 'claude'
    ? `claude mcp add ${MCP_SERVER_NAME} --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${target}`
    : `codex mcp add ${MCP_SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${target}`
}

export function buildRemoveCommand(agent: AgentId, name: string): string {
  return agent === 'claude'
    ? `claude mcp remove --scope user ${shellQuote(name)}`
    : `codex mcp remove ${shellQuote(name)}`
}

// ---------- public surface ----------

export async function mcpServerStatus(): Promise<McpStatus> {
  const scriptPath = mcpScriptPath()
  const clis = await installedClis()
  const agents: McpAgentStatus[] = (['claude', 'codex'] as AgentId[]).map((agent) => {
    if (!clis.has(agent)) return { agent, state: 'cli-missing' }
    const entry = readEntry(agent, MCP_SERVER_NAME)
    if (entry) {
      return {
        agent,
        state: isCurrent(entry, process.execPath, scriptPath) ? 'connected' : 'stale',
        registered: describe(entry)
      }
    }
    const legacy = readEntry(agent, LEGACY_MCP_SERVER_NAME)
    if (legacy) return { agent, state: 'legacy', registered: describe(legacy) }
    return { agent, state: 'disconnected' }
  })
  return { scriptPath, agents }
}

/**
 * Register (or re-register) with one agent, clearing a pre-rename entry of
 * ours first so the user isn't left with two servers exposing the same tools.
 * `mcp add` overwrites an existing entry of the same name, so reconnecting a
 * stale registration needs no removal.
 */
export async function connectMcpServer(agent: AgentId): Promise<McpConnectResult> {
  const scriptPath = mcpScriptPath()
  if (!scriptPath) {
    return {
      agent,
      ok: false,
      error: app.isPackaged
        ? 'The MCP server bundle is missing from this build of Chewo.'
        : 'No dev build of the MCP server — run `npm run build:mcp`.'
    }
  }
  if (readEntry(agent, LEGACY_MCP_SERVER_NAME)) {
    await runLoginShell(buildRemoveCommand(agent, LEGACY_MCP_SERVER_NAME))
  }
  const run = await runLoginShell(buildAddCommand(agent, process.execPath, scriptPath))
  return run.ok ? { agent, ok: true } : { agent, ok: false, error: run.output.slice(0, 300) }
}

export async function disconnectMcpServer(agent: AgentId): Promise<McpConnectResult> {
  const name = readEntry(agent, MCP_SERVER_NAME) ? MCP_SERVER_NAME : LEGACY_MCP_SERVER_NAME
  const run = await runLoginShell(buildRemoveCommand(agent, name))
  return run.ok ? { agent, ok: true } : { agent, ok: false, error: run.output.slice(0, 300) }
}

/**
 * Launch repair. Only touches agents the user already connected: a stale path
 * (the app was moved or upgraded) is re-pointed, and a surviving
 * `context-bridge` entry is migrated to the new name. Never adds a first
 * registration — that stays an explicit choice in Settings.
 *
 * Packaged builds only. In dev this would fight the installed app over the
 * same two config entries on every `npm run dev`.
 */
export async function reconcileMcpServer(): Promise<void> {
  if (!app.isPackaged || !mcpScriptPath()) return
  const scriptPath = mcpScriptPath()
  for (const agent of ['claude', 'codex'] as AgentId[]) {
    const entry = readEntry(agent, MCP_SERVER_NAME)
    if (entry && isCurrent(entry, process.execPath, scriptPath)) continue
    if (!entry && !readEntry(agent, LEGACY_MCP_SERVER_NAME)) continue
    await connectMcpServer(agent)
  }
}
