/**
 * Which subagent a launch tool was pointed at.
 *
 * The tool is `Agent` on CLI 2.1.233 and was `Task` before it, and both carry
 * the choice as `subagent_type` on the call's input. Reading it is what lets a
 * dispatch render as "figma-expert is doing X" instead of a chip that says
 * "Agent" — which is the whole difference between watching a plan run and
 * watching a spinner.
 *
 * Both names are matched deliberately rather than by prefix: `TaskCreate`,
 * `TaskUpdate`, `TaskList`, `TaskGet`, `TaskOutput` and `TaskStop` all begin
 * with `Task` and none of them launches anything (see `tool-tasks.ts`).
 */

const LAUNCHERS = new Set(['Agent', 'Task'])

export function launchedAgent(name: string, input: unknown): string | null {
  if (!LAUNCHERS.has(name)) return null
  if (!input || typeof input !== 'object') return null
  const type = (input as Record<string, unknown>).subagent_type
  return typeof type === 'string' && type.trim() ? type.trim() : null
}

/** What the dispatched agent was asked to do, for the chip's one-line summary. */
export function launchedTask(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const row = input as Record<string, unknown>
  // `description` is the CLI's own short label for the run; `prompt` is the
  // full brief and is far too long for a chip.
  const desc = row.description
  return typeof desc === 'string' && desc.trim() ? desc.trim() : null
}
