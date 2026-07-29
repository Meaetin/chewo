import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentDef, type AgentChoice } from '../shared/agents'
import { shellQuote } from '../shared/shell'
import { buildPtyEnv } from './terminals'

/**
 * One place that knows how to drive a CLI agent headlessly, so the notes and
 * todo features stay agent-agnostic (SPEC-NOTES §7/§9, SPEC-TODOS §6).
 *
 * Same shape as the ptys: `/bin/zsh -ilc` so PATH matches the user's terminal,
 * prompt over stdin so it never lands in argv (or in `ps`). The flags and the
 * output envelopes differ per agent and are normalized here:
 *
 *   claude  -p --output-format json          → { result }
 *           -p --output-format stream-json   → Anthropic message events
 *           --json-schema '<json>'           → { structured_output }
 *   codex   exec --json                      → JSONL thread/turn/item events
 *           exec --output-schema <file>      → final agent_message is the JSON
 *
 * Only the last of those needs a temp file; everything else rides stdin/stdout.
 * Model and effort are shell-quoted before interpolation — they come from the
 * CLIs' own catalogs (discovered at runtime), not from literals we authored.
 */

/** Normalized chat events. The renderer only ever sees these. */
export type ChatEvent =
  | { type: 'chat_session'; sessionId: string }
  /** `delta` = append to the current bubble; false = start a new one */
  | { type: 'chat_text'; text: string; delta: boolean }
  | { type: 'chat_tool'; name: string }
  | { type: 'chat_result'; isError: boolean }
  | { type: 'chat_error'; message: string }
  | { type: 'chat_closed' }

/** Model ids and effort levels come from the CLIs' own catalogs, so they are
 *  shell-quoted rather than trusted — a slug is not a literal we authored. */
function modelFlag(choice: AgentChoice): string {
  const def = agentDef(choice.agent)
  const model = choice.model || def.defaultModel
  if (!model) return ''
  return def.id === 'claude' ? ` --model ${shellQuote(model)}` : ` -m ${shellQuote(model)}`
}

function effortFlag(choice: AgentChoice): string {
  const def = agentDef(choice.agent)
  if (!choice.effort) return ''
  return def.id === 'claude'
    ? ` --effort ${shellQuote(choice.effort)}`
    : ` -c model_reasoning_effort=${shellQuote(choice.effort)}`
}

/**
 * OpenAI strict mode (what `codex exec --output-schema` validates against)
 * demands that every object list all of its properties in `required` and set
 * `additionalProperties: false`. Our schemas already type optional fields as
 * `['string','null']`, so widening `required` costs nothing but a null instead
 * of an absent key — which the command types already tolerate.
 */
export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>))
    out[key] = toStrictSchema(value)
  const props = out.properties
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    out.required = Object.keys(props as Record<string, unknown>)
    out.additionalProperties = false
  }
  return out
}

/** Last `agent_message` in a codex JSONL stream — its final answer. */
function lastCodexMessage(stdout: string): string | null {
  let text: string | null = null
  let failure: string | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue // codex prints a human banner before the JSONL
    }
    if (ev.type === 'error' && typeof ev.message === 'string') failure = ev.message
    if (ev.type === 'turn.failed') {
      const err = ev.error as { message?: string } | undefined
      failure = err?.message ?? failure ?? 'turn failed'
    }
    const item = ev.item as { type?: string; text?: string } | undefined
    if (ev.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string')
      text = item.text
  }
  if (text !== null) return text
  if (failure) throw new Error(failure.slice(0, 300))
  return null
}

interface RunOpts {
  choice: AgentChoice
  cwd: string
  prompt: string
  timeoutMs: number
  /** Named in errors so a failure says which feature broke */
  label: string
  /** JSON Schema (as a string) to force structured output */
  schema?: string
}

/** Spawn, feed the prompt over stdin, resolve with raw stdout. */
function run(cmd: string, opts: RunOpts): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('/bin/zsh', ['-ilc', cmd], {
      cwd: opts.cwd,
      env: buildPtyEnv(process.env)
    })
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s`))
    }, opts.timeoutMs)

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`${opts.label} failed to start: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timeout)
      // codex reports model/schema errors as JSONL *and* a non-zero exit, so
      // parse stdout first — it carries the useful message, stderr rarely does.
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`${agentDef(opts.choice.agent).bin} exited ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      resolvePromise(stdout)
    })
    proc.stdin.write(opts.prompt)
    proc.stdin.end()
  })
}

/** Run a prompt and resolve with the agent's final answer as plain text. */
export async function runAgentText(opts: Omit<RunOpts, 'schema'>): Promise<string> {
  const def = agentDef(opts.choice.agent)
  if (def.id === 'claude') {
    const cmd = `claude -p${modelFlag(opts.choice)}${effortFlag(opts.choice)} --output-format json`
    const stdout = await run(cmd, opts)
    let parsed: { result?: string; is_error?: boolean }
    try {
      parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean }
    } catch {
      throw new Error(`Unparseable claude -p output for ${opts.label}`)
    }
    if (parsed.is_error || typeof parsed.result !== 'string')
      throw new Error(`claude reported an error result for ${opts.label}`)
    return parsed.result.trim()
  }

  const cmd =
    `codex exec --json -s read-only --skip-git-repo-check` +
    `${modelFlag(opts.choice)}${effortFlag(opts.choice)} -`
  const stdout = await run(cmd, opts)
  const text = lastCodexMessage(stdout)
  if (text === null) throw new Error(`codex returned no message for ${opts.label}`)
  return text.trim()
}

/**
 * Run a prompt under a JSON Schema and resolve with the parsed object.
 * Claude returns it in `structured_output`; codex makes the final message the
 * JSON itself, so both collapse to "an object matching the schema".
 */
export async function runAgentJson(opts: RunOpts & { schema: string }): Promise<unknown> {
  const def = agentDef(opts.choice.agent)

  if (def.id === 'claude') {
    // The schema is a compile-time constant — JSON, so no single quotes to escape
    const cmd =
      `claude -p${modelFlag(opts.choice)}${effortFlag(opts.choice)} --output-format json` +
      ` --json-schema '${opts.schema}'`
    const stdout = await run(cmd, opts)
    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(stdout.trim()) as Record<string, unknown>
    } catch {
      throw new Error(`${opts.label} returned unparseable output.`)
    }
    // `result` (a JSON string) is the fallback in case a CLI update moves or
    // renames `structured_output`.
    if (envelope.structured_output !== undefined) return envelope.structured_output
    if (typeof envelope.result === 'string') {
      try {
        return JSON.parse(envelope.result)
      } catch {
        throw new Error(`${opts.label} gave no structured output: ${envelope.result.slice(0, 120)}`)
      }
    }
    throw new Error(`${opts.label} gave no structured output.`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'chewo-schema-'))
  const schemaPath = join(dir, 'schema.json')
  try {
    writeFileSync(schemaPath, JSON.stringify(toStrictSchema(JSON.parse(opts.schema))))
    const cmd =
      `codex exec --json -s read-only --skip-git-repo-check` +
      `${modelFlag(opts.choice)}${effortFlag(opts.choice)}` +
      ` --output-schema '${schemaPath}' -`
    const stdout = await run(cmd, opts)
    const text = lastCodexMessage(stdout)
    if (text === null) throw new Error(`${opts.label} returned no output.`)
    try {
      return JSON.parse(text.trim())
    } catch {
      throw new Error(`${opts.label} returned unparseable output: ${text.slice(0, 120)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- streaming chat ----------

export interface ChatSpawnOpts {
  choice: AgentChoice
  cwd: string
  message: string
  resumeSessionId?: string
}

/**
 * Read-only Q&A. Claude is held to read-only by tool allow/deny lists;
 * codex by its `read-only` sandbox. Neither is a filesystem jail — in both
 * cases the cwd is what scopes the answer, the sandbox only stops writes.
 */
export function chatCommand(opts: ChatSpawnOpts): string {
  const def = agentDef(opts.choice.agent)
  if (def.id === 'claude') {
    // allowedTools only pre-approves — the user's global permission allowlist
    // could still let Bash/Write through, so scope-breaking tools are denied
    // explicitly.
    const resume = opts.resumeSessionId ? ` --resume ${opts.resumeSessionId}` : ''
    return (
      `claude -p${modelFlag(opts.choice)}${effortFlag(opts.choice)}` +
      ' --output-format stream-json --verbose' +
      ' --allowedTools "Read,Grep,Glob"' +
      ' --disallowedTools "Bash,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch"' +
      resume
    )
  }
  const flags =
    `--json -s read-only --skip-git-repo-check${modelFlag(opts.choice)}${effortFlag(opts.choice)}`
  return opts.resumeSessionId
    ? `codex exec resume ${opts.resumeSessionId} ${flags} -`
    : `codex exec ${flags} -`
}

/** Codex item types that mean "the agent is working", not "here's the answer". */
const CODEX_TOOL_ITEMS: Record<string, string> = {
  command_execution: 'shell',
  file_change: 'edit',
  mcp_tool_call: 'tool',
  web_search: 'search',
  todo_list: 'plan'
}

/** Translate one raw agent event into zero or more normalized ChatEvents. */
export function normalizeChatEvent(agent: AgentChoice['agent'], ev: Record<string, unknown>): ChatEvent[] {
  if (agentDef(agent).id === 'claude') {
    const type = ev.type as string
    if (type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string')
      return [{ type: 'chat_session', sessionId: ev.session_id }]
    if (type === 'assistant') {
      const message = ev.message as
        | { content?: Array<{ type?: string; text?: string; name?: string }> }
        | undefined
      const out: ChatEvent[] = []
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && block.text)
          out.push({ type: 'chat_text', text: block.text, delta: true })
        else if (block.type === 'tool_use')
          out.push({ type: 'chat_tool', name: block.name ?? 'tool' })
      }
      return out
    }
    if (type === 'result') return [{ type: 'chat_result', isError: Boolean(ev.is_error) }]
    return []
  }

  // codex
  const type = ev.type as string
  if (type === 'thread.started' && typeof ev.thread_id === 'string')
    return [{ type: 'chat_session', sessionId: ev.thread_id }]
  if (type === 'item.started' || type === 'item.completed') {
    const item = ev.item as { type?: string; text?: string } | undefined
    if (!item?.type) return []
    if (item.type === 'agent_message')
      return type === 'item.completed' && typeof item.text === 'string'
        ? // codex emits whole messages, not deltas — each one is its own bubble
          [{ type: 'chat_text', text: item.text, delta: false }]
        : []
    const tool = CODEX_TOOL_ITEMS[item.type]
    return tool && type === 'item.started' ? [{ type: 'chat_tool', name: tool }] : []
  }
  if (type === 'turn.completed') return [{ type: 'chat_result', isError: false }]
  if (type === 'turn.failed') {
    const err = ev.error as { message?: string } | undefined
    return [{ type: 'chat_error', message: err?.message ?? 'The answer failed — try again.' }]
  }
  if (type === 'error' && typeof ev.message === 'string')
    return [{ type: 'chat_error', message: ev.message }]
  return []
}

export type { ChildProcessWithoutNullStreams }
