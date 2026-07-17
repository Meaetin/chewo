import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CopyDestination, CopyResult, McpRef } from '../shared/capabilities/types'

const execFileAsync = promisify(execFile)

/**
 * MCP copying (SPEC-CAPABILITIES.md C4). Routing rules:
 * - Claude + project → merge into <proj>/.mcp.json (CC reads it fresh per
 *   session; unlike ~/.claude.json it is not live-rewritten, safe to write)
 * - Claude + Personal → shell out to `claude mcp add --scope user` — we
 *   NEVER hand-write ~/.claude.json
 * - Codex + Personal → shell out to `codex mcp add` (global; stdio only)
 * - Codex + project → unsupported by Codex, always an error result
 * - env VALUES are never copied — result carries the key names to re-enter
 */

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export function buildClaudeMcpAddCommand(ref: McpRef): string | null {
  if (ref.raw?.url) {
    return `claude mcp add --scope user --transport http ${shellQuote(ref.name)} ${shellQuote(ref.raw.url)}`
  }
  if (ref.raw?.command) {
    const args = (ref.raw.args ?? []).map(shellQuote).join(' ')
    return `claude mcp add --scope user ${shellQuote(ref.name)} -- ${shellQuote(ref.raw.command)}${args ? ' ' + args : ''}`
  }
  return null
}

export function buildCodexMcpAddCommand(ref: McpRef): string | null {
  if (!ref.raw?.command) return null // url-based servers: not supported via codex mcp add
  const args = (ref.raw.args ?? []).map(shellQuote).join(' ')
  return `codex mcp add ${shellQuote(ref.name)} -- ${shellQuote(ref.raw.command)}${args ? ' ' + args : ''}`
}

/** Merge a server entry into <proj>/.mcp.json without disturbing other keys. */
export function addMcpToProjectFile(
  ref: McpRef,
  projectPath: string,
  overwrite = false
): 'copied' | 'exists' {
  const filePath = join(projectPath, '.mcp.json')
  let cfg: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {}
  if (existsSync(filePath)) {
    cfg = JSON.parse(readFileSync(filePath, 'utf8'))
  }
  cfg.mcpServers ??= {}
  if (cfg.mcpServers[ref.name] && !overwrite) return 'exists'

  const entry: Record<string, unknown> = {}
  if (ref.raw?.url) {
    entry.type = 'http'
    entry.url = ref.raw.url
  } else {
    entry.command = ref.raw?.command
    if (ref.raw?.args?.length) entry.args = ref.raw.args
  }
  // env deliberately omitted — secrets are never copied
  cfg.mcpServers[ref.name] = entry
  mkdirSync(projectPath, { recursive: true })
  writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n')
  return 'copied'
}

/** Run a CLI command through a login shell so PATH resolves in packaged apps. */
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

export async function copyMcp(
  ref: McpRef,
  destinations: CopyDestination[],
  overwrite = false
): Promise<CopyResult[]> {
  const results: CopyResult[] = []
  for (const dest of destinations) {
    const envNote = ref.envKeys?.length
      ? ` (env not copied — set manually: ${ref.envKeys.join(', ')})`
      : ''
    try {
      if (dest.tool === 'codex' && dest.kind === 'project') {
        results.push({
          dest,
          status: 'error',
          path: '',
          error: 'Codex has no per-project MCP servers — use Personal · Codex instead'
        })
      } else if (dest.tool === 'claude' && dest.kind === 'project') {
        const status = addMcpToProjectFile(ref, dest.path!, overwrite)
        results.push({ dest, status, path: join(dest.path!, '.mcp.json'), error: status === 'copied' && envNote ? envNote : undefined })
      } else {
        const command =
          dest.tool === 'claude' ? buildClaudeMcpAddCommand(ref) : buildCodexMcpAddCommand(ref)
        if (!command) {
          results.push({
            dest,
            status: 'error',
            path: '',
            error: dest.tool === 'codex' ? 'URL-based servers cannot be added to Codex' : 'entry has no command or url'
          })
          continue
        }
        const run = await runLoginShell(command)
        results.push(
          run.ok
            ? { dest, status: 'copied', path: command, error: envNote || undefined }
            : { dest, status: 'error', path: command, error: run.output.slice(0, 300) }
        )
      }
    } catch (err) {
      results.push({
        dest,
        status: 'error',
        path: '',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return results
}
