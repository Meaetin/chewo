import { scanCapabilities } from '../shared/capabilities/scan'
import { listInstalledPlugins } from './plugins'
import { orchestratorBrief, type DispatchableAgent } from '../shared/orchestrator'

/**
 * Who a lead session can actually dispatch to, resolved at spawn.
 *
 * Read fresh rather than cached: agents are files, and the whole point of the
 * builder is that you can write one and use it in the next session. A cache
 * measured in minutes would make "I just made this agent" the failure case.
 *
 * Plugin-provided agents count — they are in the CLI's roster exactly like a
 * hand-written one (verified 2026-08-17: `docs-researcher` comes from the
 * context7 plugin and the Agent tool lists it) — but the ones inside a
 * **disabled** plugin do not, because the CLI will not launch them. Briefing a
 * lead to dispatch to an agent that cannot start is worse than not naming it.
 */
export async function dispatchableAgents(
  cwd: string | null | undefined
): Promise<DispatchableAgent[]> {
  try {
    const plugins = await listInstalledPlugins()
    const projects = cwd ? [{ id: 'cwd', name: 'project', path: cwd }] : []
    const inventories = scanCapabilities(projects, { plugins })
    const seen = new Set<string>()
    const agents: DispatchableAgent[] = []
    for (const inv of inventories) {
      for (const agent of inv.agents) {
        if (agent.origin.kind === 'plugin' && !agent.origin.enabled) continue
        if (!agent.name || seen.has(agent.name)) continue
        seen.add(agent.name)
        agents.push({
          name: agent.name,
          description: agent.description,
          ...(agent.color ? { color: agent.color } : {})
        })
      }
    }
    return agents
  } catch {
    // A failed scan must not stop a session opening. An empty roster means the
    // pane runs as an ordinary chat, which is the honest degradation — the
    // alternative is refusing to start over a directory read.
    return []
  }
}

/** The brief for a lead session, or `''` when there is nobody to dispatch to. */
export async function orchestratorPrompt(cwd: string | null | undefined): Promise<string> {
  return orchestratorBrief(await dispatchableAgents(cwd))
}
