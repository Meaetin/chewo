import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAgentJson } from './agent-runner'
import { agentFor } from './settings'
import {
  SCHEMA,
  buildPrompt,
  readDraft,
  type DraftRequest,
  type DraftResult
} from '../shared/capabilities/agent-draft'
import type { AgentChoice } from '../shared/agents'

/**
 * Natural language in, a subagent draft out.
 *
 * Nothing here writes: the draft is a proposal the user reviews and edits
 * before `capability-writer` puts anything on disk. That split is the point —
 * an agent definition is a system prompt plus a tool policy, and both are
 * things a person should read before they start running.
 *
 * Agent-agnostic like every other headless feature: the CLI choice comes from
 * Settings → Agents through `agentFor('agentBuild')`, and the whole
 * per-CLI divergence lives in `agent-runner.ts`.
 */

/**
 * Twice the git text budget, because the output is a different size: a commit
 * subject is one line, a system prompt is the agent's entire brief.
 *
 * Measured 2026-08-17 by `npm run canary:agent` against CLI 2.1.233 at
 * opus/high: **72.3s** for a 6,183-character system prompt. So the 90s that
 * suits `gitText` would kill a working call about as often as not.
 *
 * There is no fallback to race here — unlike `gitText`, where a deterministic
 * local string beats a slow model, a locally-invented system prompt would be
 * worse than an honest failure — so this only has to be long enough that a
 * working CLI is never killed just before it answers. Erring long is free.
 */
const TIMEOUT_MS = 180_000

/**
 * Filled in when Settings leaves model or effort blank. Authoring a system
 * prompt is quality-dominant and happens once per agent, so this pins the
 * capable end rather than the fast one — the opposite trade from `gitText`,
 * where the same blank means "don't make Ship wait". An explicit Settings
 * choice still wins, and codex is left alone: its catalog is discovered at
 * runtime, so no id can be hardcoded honestly.
 */
const CAPABLE: AgentChoice = { agent: 'claude', model: 'opus', effort: 'high' }

/**
 * Pinned outside the user's repos like every other headless feature. A CLI
 * writes a session file keyed on its cwd and the sidebar files sessions into
 * projects by that path, so running this in the repo you happen to be standing
 * in puts a "Build me an agent that…" row in that project's session list.
 */
function neutralCwd(): string {
  const dir = join(homedir(), '.chewo', 'agent-builder')
  mkdirSync(dir, { recursive: true })
  return dir
}

function choice(): AgentChoice {
  const chosen = agentFor('agentBuild')
  if (chosen.agent !== CAPABLE.agent) return chosen
  return {
    ...chosen,
    model: chosen.model || CAPABLE.model,
    effort: chosen.effort || CAPABLE.effort
  }
}

/**
 * Ask the configured CLI for a draft.
 *
 * A failure is reported, never papered over. Unlike `gitText` — where a
 * deterministic local string beats a slow model and the fallback is honest —
 * there is no local way to invent a system prompt, and presenting one as a
 * proposal would be worse than saying the call failed.
 */
export async function draftAgent(req: DraftRequest): Promise<DraftResult> {
  try {
    const raw = await runAgentJson({
      choice: choice(),
      cwd: neutralCwd(),
      prompt: buildPrompt(req),
      schema: SCHEMA,
      timeoutMs: TIMEOUT_MS,
      label: 'Agent builder'
    })
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'The builder returned no draft.' }
    return { ok: true, draft: readDraft(raw as Record<string, unknown>, req.skills) }
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }
  }
}
