import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where Chewo's MCP server keeps its state: the pull-based handoff inboxes and
 * the audit log (SPEC.md §4.5). Lives under `~/.chewo` with the todo boards and
 * speech models rather than a dotdir of its own, so everything the app owns
 * outside userData sits in one greppable place.
 *
 * Imported by BOTH the app (which watches the inbox to nudge a pane) and the
 * out-of-process server — one definition, no path drift between them. Split
 * from `chewo-mcp.ts` because that one is renderer-safe and this touches fs.
 */

export const MCP_ROOT = join(homedir(), '.chewo', 'mcp')

/** Pre-rename home of the same state, when the server was `context-bridge`. */
export const LEGACY_MCP_ROOT = join(homedir(), '.context-bridge')

/**
 * Move a pre-rename state dir to the new root. Called by the app at launch and
 * by the server at startup — whichever runs first migrates, the other no-ops.
 * Pending handoffs and the audit trail come along; on failure the old dir is
 * left untouched and callers proceed with an empty new root rather than
 * splitting state across two of them.
 */
export function adoptLegacyMcpRoot(): void {
  if (existsSync(MCP_ROOT) || !existsSync(LEGACY_MCP_ROOT)) return
  try {
    mkdirSync(dirname(MCP_ROOT), { recursive: true })
    renameSync(LEGACY_MCP_ROOT, MCP_ROOT)
  } catch {
    /* raced with the other process, or unwritable */
  }
}
