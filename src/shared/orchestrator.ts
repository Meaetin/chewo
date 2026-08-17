/**
 * The brief that turns a session into a dispatcher.
 *
 * Why this has to exist: a stock session that already holds the tools a
 * specialist agent would use will do the work itself, every time, and it is
 * right to — delegating costs a fresh context that cannot see the
 * conversation and has to be re-briefed. Automatic delegation is a judgement
 * the model makes from one line of `description`, not a routing table, so
 * "install an expert agent and it gets used" is simply not how it behaves.
 * Verified here 2026-08-17: a session with a figma agent installed and the
 * Figma MCP tools available called those tools directly and never delegated.
 *
 * So orchestration is asked for, and asked for **per session** — this is
 * appended with `--append-system-prompt`, which is a spawn flag. It is
 * deliberately not a global setting and deliberately not the default: the
 * right answer depends on the task, not on the user. A long parallelisable
 * build wants fan-out; a one-line CSS fix wants the agent in front of you to
 * just do it.
 *
 * Pure and DOM-free, tested like `ship-route.ts`.
 */

export interface DispatchableAgent {
  name: string
  description: string
  /**
   * The agent's own `color` frontmatter, when it set one. Not used in the
   * brief — it is carried here so the renderer can tint the chip that says
   * who is doing what without a second scan.
   */
  color?: string
}

/** Past this the brief is a wall of text; the rest stay discoverable. */
const MAX_LISTED = 24

/**
 * The appended system prompt, or `''` when there is nobody to dispatch to.
 *
 * An empty string is meaningful: the caller passes no flag at all rather than
 * briefing a session to delegate to an empty roster, which produces an agent
 * that announces a plan and then does everything itself anyway — worse than
 * not asking, because it reads as the feature being broken.
 */
export function orchestratorBrief(agents: DispatchableAgent[]): string {
  if (agents.length === 0) return ''
  const listed = agents.slice(0, MAX_LISTED)
  const roster = listed.map((a) => `- ${a.name}: ${a.description}`)
  return [
    '# Working as a lead',
    '',
    'For this session you coordinate specialist subagents rather than doing',
    'every part of the work yourself.',
    '',
    '## The roster',
    '',
    ...roster,
    agents.length > listed.length
      ? `- …and ${agents.length - listed.length} more, listed by the Agent tool.`
      : '',
    '',
    '## How to work',
    '',
    '1. Read the request and say briefly what you understand it to need. If it',
    '   is ambiguous in a way that changes who should do it, ask first.',
    '2. Break it into tasks with `TaskCreate`, one per unit of work that a',
    '   single agent can finish. Set `owner` to the name of the agent that will',
    '   do it — the owner is how the person watching knows who is on what, so',
    '   never leave it blank on a task you intend to delegate.',
    '3. Dispatch each task with the Agent tool, passing that agent as',
    '   `subagent_type`. Give it everything it needs in the prompt: it cannot',
    '   see this conversation, the files you have read, or what the other',
    '   agents are doing.',
    '4. Move tasks with `TaskUpdate` as they start and finish, so the plan',
    '   stays true while it runs.',
    '5. Read what comes back and judge it. A subagent reporting done is a claim,',
    '   not a result — if it does not hold up, say so and dispatch again.',
    '',
    '## When not to delegate',
    '',
    'Delegation costs a fresh context and a round trip, so it has to buy',
    'something. Do the work yourself, with no task and no dispatch, when:',
    '',
    '- it is a single small edit, a question, or a lookup;',
    '- no agent on the roster covers it, and a general-purpose one would just',
    '  be you with less context;',
    '- it needs the conversation you are in the middle of.',
    '',
    'One agent doing an obvious job directly is a good outcome. A plan with',
    'one task per file, dispatched to agents that were not written for them,',
    'is slower and worse than not planning at all.'
  ]
    .filter((line) => line !== '')
    .join('\n')
}
