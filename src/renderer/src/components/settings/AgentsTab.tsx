import { useEffect, useState } from 'react'
import {
  AGENT_IDS,
  AGENT_TASKS,
  agentDef,
  EFFORT_LEVELS,
  type AgentAssignments,
  type AgentChoice,
  type AgentId,
  type AgentModel,
  type AgentTask
} from '../../../../shared/agents'
import { Select, type SelectOption } from '../Select'

/**
 * Which CLI runs each headless AI feature, on which model, at what reasoning
 * effort. Every list is derived rather than hardcoded: agents come from the
 * registry, models from `agents:models` (which discovers Codex's catalog from
 * the CLI and uses Claude's self-updating aliases), and the effort ladder from
 * the selected model — the accepted levels differ per model, not per agent.
 */

const AGENT_OPTIONS: SelectOption<AgentId>[] = AGENT_IDS.map((id) => ({
  value: id,
  label: agentDef(id).label
}))

/** '' = pass no flag at all, letting the CLI use its own default. */
const DEFAULT_OPTION = { value: '', label: 'Default' }

const title = (s: string): string => s[0].toUpperCase() + s.slice(1)

interface AgentsTabProps {
  agents: AgentAssignments
  onChange: (a: AgentAssignments) => void
}

export function AgentsTab({ agents, onChange }: AgentsTabProps): React.JSX.Element {
  const [models, setModels] = useState<Record<string, AgentModel[]>>({})

  // Discovery shells out to the CLI, so fetch once per agent and cache. Main
  // caches too; this keeps the picker from flickering on every re-render.
  useEffect(() => {
    let live = true
    for (const id of AGENT_IDS) {
      if (models[id]) continue
      void window.api.listAgentModels(id).then((list) => {
        if (live) setModels((m) => ({ ...m, [id]: list }))
      })
    }
    return () => {
      live = false
    }
  }, [models])

  const modelsFor = (agent: AgentId): AgentModel[] => models[agent] ?? agentDef(agent).models

  const set = (task: AgentTask, patch: Partial<AgentChoice>): void => {
    const next: AgentChoice = { ...agents[task], ...patch }
    // Switching agents invalidates a model named on the old CLI, and the new
    // model may not accept the old effort — clearing beats a spawn-time error.
    if (patch.agent && patch.agent !== agents[task].agent) {
      delete next.model
      delete next.effort
    } else if (patch.model !== undefined) {
      const efforts = modelsFor(next.agent).find((m) => m.id === next.model)?.efforts
      if (next.effort && efforts && !efforts.includes(next.effort)) delete next.effort
    }
    if (!next.model) delete next.model
    if (!next.effort) delete next.effort
    onChange({ ...agents, [task]: next })
  }

  const groups = [...new Set(AGENT_TASKS.map((t) => t.group))]

  return (
    <div className="settings-agents">
      {groups.map((group) => (
        <section key={group} className="settings-agent-group">
          <h3 className="settings-agent-group-title">{group}</h3>
          {AGENT_TASKS.filter((t) => t.group === group).map((task) => {
            const choice = agents[task.id]
            const def = agentDef(choice.agent)
            const list = modelsFor(choice.agent)
            const selected = list.find((m) => m.id === choice.model)
            const efforts = selected?.efforts ?? EFFORT_LEVELS

            const modelOptions: SelectOption<string>[] = [
              DEFAULT_OPTION,
              ...list.map((m) => ({ value: m.id, label: m.label, detail: m.detail })),
              // A model saved before a CLI update may no longer be listed —
              // keep it selectable so the setting still shows what will run.
              ...(choice.model && !selected
                ? [{ value: choice.model, label: choice.model, detail: 'Not in this CLI’s catalog' }]
                : [])
            ]

            const effortOptions: SelectOption<string>[] = [
              DEFAULT_OPTION,
              ...efforts.map((e) => ({ value: e, label: title(e) })),
              ...(choice.effort && !efforts.includes(choice.effort)
                ? [{ value: choice.effort, label: title(choice.effort) }]
                : [])
            ]

            return (
              <div key={task.id} className="settings-agent-row">
                <div className="settings-agent-meta">
                  <label className="settings-agent-label" htmlFor={`agent-${task.id}`}>
                    {task.label}
                  </label>
                  <div className="settings-agent-hint">{task.hint}</div>
                  {task.id === 'notesChat' && !def.streamsDeltas && (
                    <div className="settings-agent-note">
                      {def.label} returns each answer in one piece — replies appear complete rather
                      than typing out.
                    </div>
                  )}
                </div>
                <div className="settings-agent-controls">
                  <div className="settings-agent-control">
                    <span className="settings-agent-control-label">Agent</span>
                    <Select
                      id={`agent-${task.id}`}
                      value={choice.agent}
                      options={AGENT_OPTIONS}
                      onChange={(agent) => set(task.id, { agent })}
                    />
                  </div>
                  <div className="settings-agent-control settings-agent-control-wide">
                    <span className="settings-agent-control-label">Model</span>
                    <Select
                      value={choice.model ?? ''}
                      options={modelOptions}
                      onChange={(model) => set(task.id, { model })}
                    />
                  </div>
                  <div className="settings-agent-control">
                    <span className="settings-agent-control-label">Reasoning</span>
                    <Select
                      value={choice.effort ?? ''}
                      options={effortOptions}
                      onChange={(effort) => set(task.id, { effort })}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}
