import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentDef, EFFORT_LEVELS, type AgentId, type AgentModel } from '../shared/agents'
import { buildPtyEnv } from './terminals'

const execFileAsync = promisify(execFile)

/**
 * The models each agent will accept for its model flag.
 *
 * The two CLIs need opposite strategies, and both avoid a hardcoded list that
 * rots on the next release:
 *
 *   claude — has no model-listing command, but its `--model` flag takes
 *            *aliases* ('opus', 'sonnet', …) that always resolve to the
 *            latest model of that tier. The static list in the registry is
 *            therefore self-updating; pinned ids would be the fragile choice.
 *   codex  — has no stable aliases, but ships `codex debug models`, so the
 *            list is read from the CLI itself at runtime.
 *
 * Discovery is cached for the session: the catalog only changes when the CLI
 * is updated, and the call costs ~300ms and 280KB of JSON.
 */

const DISCOVERY_TIMEOUT_MS = 15_000

const cache = new Map<AgentId, AgentModel[]>()

interface CodexCatalogEntry {
  slug?: string
  display_name?: string
  description?: string
  visibility?: string
  priority?: number
  default_reasoning_level?: string
  supported_reasoning_levels?: Array<{ effort?: string }>
}

/** Parse `codex debug models` output into the picker's shape. */
export function parseCodexModels(stdout: string): AgentModel[] {
  let parsed: { models?: CodexCatalogEntry[] }
  try {
    parsed = JSON.parse(stdout) as { models?: CodexCatalogEntry[] }
  } catch {
    return []
  }
  return (parsed.models ?? [])
    // 'list' is the catalog's own "show this to users" flag — anything else is
    // an internal or deprecated entry we have no business offering.
    .filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((m) => {
      const efforts = (m.supported_reasoning_levels ?? [])
        .map((e) => e.effort)
        .filter((e): e is string => typeof e === 'string' && e.length > 0)
      return {
        id: m.slug as string,
        label: m.display_name || (m.slug as string),
        // Per-model, not per-agent: gpt-5.5 has no 'max', gpt-5.6-sol adds 'ultra'
        efforts: efforts.length ? efforts : EFFORT_LEVELS,
        detail: m.description
      }
    })
}

/**
 * Models for the picker. Falls back to the registry's static list when the
 * agent can't be enumerated or the CLI isn't installed — a missing binary
 * should leave the setting usable, not empty.
 */
export async function listAgentModels(agent: AgentId): Promise<AgentModel[]> {
  const cached = cache.get(agent)
  if (cached) return cached

  const def = agentDef(agent)
  if (!def.discoverable) {
    cache.set(agent, def.models)
    return def.models
  }

  try {
    // Login shell so PATH matches the user's terminal, same as every other spawn
    const { stdout } = await execFileAsync('/bin/zsh', ['-ilc', `${def.bin} debug models`], {
      env: buildPtyEnv(process.env),
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024
    })
    const models = parseCodexModels(stdout)
    if (models.length) {
      cache.set(agent, models)
      return models
    }
  } catch {
    /* not installed, not signed in, or the command moved — fall through */
  }
  return def.models
}

/** Forget discovered catalogs so a CLI update is picked up without a restart. */
export function resetAgentModelCache(): void {
  cache.clear()
}
