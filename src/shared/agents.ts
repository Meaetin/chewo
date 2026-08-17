import type { Source } from './adapter/types'

/**
 * Registry of the CLI agents that can run our headless AI features (notes
 * structuring, notes Q&A, todo voice commands, git branch/commit/PR text) and
 * the per-feature choice of which one runs what.
 *
 * `AgentId` is deliberately `Source` rather than a new union — there were
 * already four parallel 'claude' | 'codex' unions in the tree and a fifth
 * would rot. Because the registry is a `Record<AgentId, AgentDef>`, adding an
 * agent to `Source` makes the compiler point at every site that needs work.
 * (A headless-only agent with no session store is the one case that would
 * justify widening `AgentId` past `Source`.)
 */

export type AgentId = Source

/**
 * Reasoning effort. Claude spells this `--effort`, Codex
 * `-c model_reasoning_effort=`. Deliberately a string rather than a union:
 * the accepted set is **per model**, not per agent (verified against the
 * codex catalog — gpt-5.5 has no `max`, gpt-5.6-sol adds `ultra`), and for
 * codex it is discovered at runtime. Validation is against the model's own
 * list, so a discovered value is valid by construction.
 */
export type EffortLevel = string

/** Fallback ladder when a model doesn't declare its own. Claude's `--effort`. */
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface AgentModel {
  /** Passed verbatim to the CLI's model flag */
  id: string
  label: string
  /** Effort levels this specific model accepts */
  efforts: EffortLevel[]
  /** Shown under the label in the picker */
  detail?: string
}

export interface AgentDef {
  id: AgentId
  label: string
  /** Binary name, resolved through the user's login shell PATH */
  bin: string
  /** Model passed when the user hasn't overridden it; '' = let the CLI decide */
  defaultModel: string
  /**
   * Models offered when discovery is unavailable. Claude has no
   * model-listing command, so its list is these aliases — which track the
   * latest model of each tier and therefore never go stale, unlike pinned
   * ids. Codex ships `codex debug models`, so this is only its fallback.
   */
  models: AgentModel[]
  /** Whether `listAgentModels` can enumerate this agent's models at runtime */
  discoverable: boolean
  /**
   * Whether the agent streams assistant text incrementally. Claude's
   * stream-json emits token deltas; Codex's JSONL emits whole
   * `item.completed` messages, so its chat answers land in one piece.
   */
  streamsDeltas: boolean
  /**
   * Whether structured output must satisfy OpenAI strict mode (every
   * property listed in `required`, `additionalProperties: false`).
   */
  strictSchema: boolean
}

export const AGENTS: Record<AgentId, AgentDef> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    defaultModel: 'sonnet',
    models: [
      { id: 'opus', label: 'Opus', efforts: EFFORT_LEVELS, detail: 'Most capable' },
      { id: 'sonnet', label: 'Sonnet', efforts: EFFORT_LEVELS, detail: 'Balanced — default' },
      { id: 'haiku', label: 'Haiku', efforts: EFFORT_LEVELS, detail: 'Fastest, cheapest' },
      { id: 'fable', label: 'Fable', efforts: EFFORT_LEVELS, detail: 'Deepest reasoning' }
    ],
    discoverable: false,
    streamsDeltas: true,
    strictSchema: false
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    // Empty = pass no -m, so the user's ~/.codex/config.toml default wins.
    defaultModel: '',
    // Only a fallback — the real list comes from `codex debug models`.
    models: [],
    discoverable: true,
    streamsDeltas: false,
    strictSchema: true
  }
}

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[]

export function agentDef(id: AgentId): AgentDef {
  return AGENTS[id] ?? AGENTS.claude
}

/**
 * What an interactive session starts on before the user picks anything.
 *
 * Deliberately *not* `defaultModel` above, which is the headless features'
 * "let the CLI decide". A session you sit in front of should open on the best
 * model, and reasoning high is the point of using it.
 *
 * Neither side names a dated model id. Claude's are tier aliases that always
 * resolve to the latest of that tier. Codex has no aliases, so its slot is
 * left empty and filled from the **head of its own discovered catalog** —
 * `codex debug models` is priority-ordered, so entry 0 is the CLI's own
 * "latest frontier" pick (`gpt-5.6-sol` today). Both stay right across a CLI
 * update without anything here changing.
 */
export const NEW_SESSION_DEFAULTS: Record<AgentId, { model?: string; effort: EffortLevel }> = {
  claude: { model: 'opus', effort: 'high' },
  codex: { effort: 'high' }
}

/**
 * The model a session will actually run, given the user's pick (if any) and
 * the agent's catalog. One resolver so the picker and the spawn cannot
 * disagree about what "default" means.
 */
export function sessionModel(
  agent: AgentId,
  chosen: string | undefined,
  catalog: AgentModel[]
): string {
  if (chosen) return chosen
  return NEW_SESSION_DEFAULTS[agent]?.model ?? catalog[0]?.id ?? agentDef(agent).defaultModel
}

/** Effort for a session, clamped to what the resolved model actually accepts. */
export function sessionEffort(
  agent: AgentId,
  chosen: EffortLevel | undefined,
  model: AgentModel | undefined
): EffortLevel {
  const wanted = chosen ?? NEW_SESSION_DEFAULTS[agent]?.effort ?? 'medium'
  const allowed = model?.efforts ?? EFFORT_LEVELS
  if (allowed.includes(wanted)) return wanted
  // A model that doesn't take our default gets its own middle ground rather
  // than a flag it will reject at spawn time
  return allowed[Math.floor(allowed.length / 2)] ?? allowed[0] ?? wanted
}

// ---------- per-feature assignment ----------

/** The headless features a user can point at an agent. */
export type AgentTask = 'notesStructure' | 'notesChat' | 'todoVoice' | 'gitText' | 'agentBuild'

export interface AgentChoice {
  agent: AgentId
  /** Omitted = don't pass a model flag, let the CLI use its own default */
  model?: string
  /** Omitted = don't pass an effort flag, let the CLI decide */
  effort?: EffortLevel
}

export type AgentAssignments = Record<AgentTask, AgentChoice>

export const DEFAULT_AGENTS: AgentAssignments = {
  notesStructure: { agent: 'claude' },
  notesChat: { agent: 'claude' },
  todoVoice: { agent: 'claude' },
  gitText: { agent: 'claude' },
  agentBuild: { agent: 'claude' }
}

/** Drives the Agents settings tab; order and grouping are the UI's. */
export const AGENT_TASKS: Array<{
  id: AgentTask
  group: string
  label: string
  hint: string
}> = [
  {
    id: 'notesStructure',
    group: 'Notes',
    label: 'Structure dictation',
    hint: 'Turns a raw transcript into markdown appended to the lesson.'
  },
  {
    id: 'notesChat',
    group: 'Notes',
    label: 'Ask your notes',
    hint: 'Read-only Q&A over the notes folder, scoped by the picker.'
  },
  {
    id: 'todoVoice',
    group: 'To-dos',
    label: 'Voice commands',
    hint: 'Interprets a dictated utterance into board commands.'
  },
  {
    id: 'gitText',
    group: 'Git',
    label: 'Branch & commit text',
    hint: 'Names isolated branches from your first message, and writes commit messages and PR text for Ship. Never blocks: a failure falls back to a plain generated string.'
  },
  {
    id: 'agentBuild',
    group: 'Capabilities',
    label: 'Agent builder',
    hint: 'Turns a description into a subagent draft — system prompt, model, tool policy and suggested skills — for you to review before anything is written.'
  }
]

/** Fills in any task missing from a persisted (or older) settings file. */
export function normalizeAgents(partial: Partial<AgentAssignments> | undefined): AgentAssignments {
  const out = {} as AgentAssignments
  for (const { id } of AGENT_TASKS) {
    const choice = partial?.[id]
    const known = Boolean(choice && choice.agent in AGENTS)
    const agent = known ? (choice as AgentChoice).agent : DEFAULT_AGENTS[id].agent
    // Model and effort belong to the agent that was chosen. If the agent had
    // to be repaired, they name something on a different CLI — drop them
    // rather than carry a flag that would fail at spawn time. Otherwise they
    // pass through: the valid set is per-model and discovered at runtime, so
    // this layer can only check the shape.
    const next: AgentChoice = { agent }
    if (known) {
      const model = (choice as AgentChoice).model
      const effort = (choice as AgentChoice).effort
      if (typeof model === 'string' && model) next.model = model
      if (typeof effort === 'string' && effort) next.effort = effort
    }
    out[id] = next
  }
  return out
}
