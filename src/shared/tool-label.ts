/**
 * How a tool call is named in the thread.
 *
 * A chip that reads `Bash ls src/main/ && echo "=== preload ===" && ls …` names
 * the mechanism and buries the point. Every tool the CLI ships already carries
 * the point somewhere on its input — Bash and Agent are literally handed a
 * `description` written for a human, and the file tools have a path — so the
 * headline is read off the call rather than invented here.
 *
 * Renderer-safe and DOM-free, like `branch-names.ts` and `tool-images.ts`, so
 * the naming can be pinned by tests rather than by looking at the screen.
 */

import type { ToolCall } from './agent-chat'
import { launchedAgent, launchedTask } from './subagent'

export interface ToolLabel {
  /** What the call did, in words — the chip's headline */
  title: string
  /** What it did it to: a path, a command, a pattern. Rendered mono. */
  detail: string
}

/** Past tense on purpose: by the time a chip is read the call has happened. */
const VERBS: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edited',
  MultiEdit: 'Edited',
  Write: 'Wrote',
  NotebookEdit: 'Edited notebook',
  Grep: 'Searched',
  Glob: 'Found files',
  WebFetch: 'Fetched',
  WebSearch: 'Searched the web',
  Skill: 'Used skill',
  ToolSearch: 'Found tools',
  BashOutput: 'Read command output',
  KillShell: 'Stopped a shell'
}

/** The argument that carries the subject, per tool. */
const SUBJECT: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Skill: 'skill',
  ToolSearch: 'query',
  BashOutput: 'bash_id',
  KillShell: 'shell_id'
}

/** Arguments worth showing when a tool has no rule of its own, best first. */
const FALLBACK_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'prompt']

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const fields = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

/**
 * An MCP tool reaches us as `mcp__<server>__<tool>`, which is an address rather
 * than a name — `mcp__chewo__todo_add` is "todo add", from chewo.
 */
function mcpName(name: string): { tool: string; server: string } | null {
  const parts = name.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return null
  return { server: parts[1], tool: parts.slice(2).join('__').replace(/_/g, ' ') }
}

export function toolLabel(call: ToolCall): ToolLabel {
  const input = fields(call.input)

  // A dispatch is named after the task, not after the launcher: the chip
  // already wears the agent's own badge, so repeating "Agent" says nothing.
  if (launchedAgent(call.name, call.input) || call.name === 'Agent' || call.name === 'Task') {
    return { title: launchedTask(call.input) || 'Delegated a task', detail: '' }
  }

  // Bash is handed a human-written `description` on every call ("Run the test
  // suite"), which is the one string in the whole input that says why.
  if (call.name === 'Bash') {
    return {
      title: text(input.description) || text(call.description) || 'Ran a command',
      detail: text(input.command)
    }
  }

  const verb = VERBS[call.name]
  if (verb) return { title: verb, detail: text(input[SUBJECT[call.name]]) }

  const mcp = mcpName(call.name)
  if (mcp) return { title: mcp.tool, detail: mcp.server }

  // Anything unknown — a plugin's tool, a CLI update's new one. The CLI's own
  // description beats a guess; failing that the tool names itself.
  const detail = FALLBACK_KEYS.map((k) => text(input[k])).find(Boolean) ?? ''
  return { title: text(call.description) || call.displayName || call.name, detail }
}

/**
 * The arguments, as the thing they are rather than as JSON where we can manage
 * it. Approving a Write without reading it, or watching a subagent launch
 * without reading its brief, is how a GUI becomes less useful than the terminal
 * it replaced — so this never returns null for a call that has any input.
 */
export function toolInputText(call: ToolCall): string | null {
  const input = fields(call.input)
  if (Object.keys(input).length === 0) return null

  if (call.name === 'Bash') {
    const command = text(input.command)
    return command ? `$ ${command}` : null
  }
  // The brief a subagent was given is the whole content of a dispatch, and it
  // is prose — JSON-escaping it into one long line makes it unreadable.
  const prompt = call.name === 'Agent' || call.name === 'Task' ? text(input.prompt) : ''
  if (prompt) return prompt
  if (call.name === 'Write') {
    const content = text(input.content)
    if (content) return content
  }
  return JSON.stringify(input, null, 2)
}
