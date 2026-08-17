import { execFile } from 'node:child_process'
import type { InstalledPlugin } from '../shared/capabilities/types'
import { buildPtyEnv } from './terminals'

/**
 * Installed Claude Code plugins, read through the CLI.
 *
 * Why this exists at all: a plugin's skills and agents live under
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, not in
 * `~/.claude/skills` or `~/.claude/agents`, so the capability scanner used to
 * miss almost all of them — 4 skills found against 132 actually installed on
 * this machine (measured 2026-08-17).
 *
 * Why via the CLI rather than globbing that cache: the cache keeps **several
 * versions of the same plugin side by side** (four copies of figma here) and
 * retains disabled ones. Only `claude plugin list --json` knows which version
 * is live and which plugins are enabled; a directory walk would trip over
 * both. Same doctrine as MCP — the CLI owns this state, we read it, we never
 * hand-parse its store.
 */

/** Resolved once — a packaged Electron app does not inherit the login PATH. */
let claudePath: string | null | undefined

function shellLookup(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/bin/zsh',
      ['-ilc', `command -v ${bin}`],
      { timeout: 15_000, env: buildPtyEnv(process.env) },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null)
    )
  })
}

/** Raw row shape from `claude plugin list --json`; every field is optional to us. */
interface PluginRow {
  id?: unknown
  version?: unknown
  enabled?: unknown
  installPath?: unknown
}

/**
 * `<plugin>@<marketplace>` → its two halves.
 *
 * Split on the **last** `@` so a marketplace or plugin name that contains one
 * cannot silently reassign the halves.
 */
export function splitPluginId(id: string): { plugin: string; marketplace: string } | null {
  const at = id.lastIndexOf('@')
  if (at <= 0 || at === id.length - 1) return null
  return { plugin: id.slice(0, at), marketplace: id.slice(at + 1) }
}

/**
 * Rows → `InstalledPlugin[]`, keeping every row that named a real install
 * path, disabled ones included — a disabled plugin is still installed, and
 * saying so is what stops "my agent can't see these skills" being a silent
 * failure. Callers that need *usable* capabilities filter on `enabled`.
 *
 * Exported for testing; the shape is the CLI's, so it is parsed defensively
 * rather than trusted — same skip-don't-crash discipline as the session
 * adapter.
 */
export function parsePluginList(stdout: string): InstalledPlugin[] {
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: InstalledPlugin[] = []
  for (const row of rows as PluginRow[]) {
    if (!row || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id : ''
    const installPath = typeof row.installPath === 'string' ? row.installPath : ''
    const parts = splitPluginId(id)
    if (!parts || !installPath) continue
    out.push({
      id,
      plugin: parts.plugin,
      marketplace: parts.marketplace,
      version: typeof row.version === 'string' ? row.version : '',
      installPath,
      enabled: row.enabled !== false
    })
  }
  return out
}

/**
 * Never throws and never blocks the view: a missing CLI, a timeout or a shape
 * change all return `[]`, which degrades the Capabilities view to the
 * user/project dirs it showed before rather than failing it outright.
 */
export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  if (claudePath === undefined) claudePath = await shellLookup('claude')
  if (!claudePath) return []
  return new Promise((resolve) => {
    execFile(
      claudePath as string,
      ['plugin', 'list', '--json'],
      { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: buildPtyEnv(process.env) },
      (err, stdout) => resolve(err ? [] : parsePluginList(String(stdout)))
    )
  })
}
