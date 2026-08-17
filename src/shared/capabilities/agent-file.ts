import { parseFrontmatter, splitList } from './frontmatter'

/**
 * The one shape a Claude Code subagent has on disk, and the two functions that
 * cross between it and a form: `draftFromFile` (read) and `serializeAgent`
 * (write).
 *
 * Pure and DOM-free like `branch-names.ts` and `selectPlacement.ts`, so the
 * round-trip is testable without a filesystem — which matters more here than
 * usual, because the write end is destructive: it rewrites a file the user may
 * have hand-authored.
 *
 * A subagent file is YAML frontmatter plus a markdown body, and **the body is
 * the entire system prompt** — a subagent does not inherit Claude Code's own,
 * so an empty body is a broken agent rather than a default one.
 */

/** Frontmatter keys this app models; everything else is preserved verbatim. */
const MODELLED = [
  'name',
  'description',
  'model',
  'effort',
  'color',
  'tools',
  'disallowedTools',
  'skills'
] as const

export interface AgentDraftSkill {
  /** Skill name as it appears in the capability inventory */
  name: string
  /**
   * Why this agent wants it. Shown on the review card and **never written to
   * disk** — the frontmatter takes a bare name list, and the reasoning is for
   * the person deciding, not for the CLI.
   */
  reason: string
  /**
   * Write into `skills:`, which preloads the skill's **full body at startup,
   * every invocation** — as against leaving it discoverable, where only its
   * one-line description sits in context until the model asks for it.
   * Measured on the figma plugin: ~500 tokens for 12 descriptions against
   * ~50,000 to preload the same 12. Defaults off for that reason.
   */
  preload: boolean
  /** False when the skill is known from a catalog but not installed yet */
  installed: boolean
  /** `<plugin>@<marketplace>` to install, when it isn't installed */
  pluginId?: string
}

export interface AgentDraft {
  name: string
  /**
   * The router: what the main agent reads to decide whether to delegate. Load
   * bearing prose, not a caption.
   */
  description: string
  /** The whole system prompt — the file's body */
  systemPrompt: string
  /** Absent = `inherit`, the CLI's own default */
  model?: string
  effort?: string
  color?: string
  /** Allowlist. **Empty means every tool**, not none. */
  tools: string[]
  disallowedTools: string[]
  skills: AgentDraftSkill[]
}

/** One frontmatter key with its source lines, so unknown ones survive a save. */
interface FrontmatterEntry {
  key: string
  /** Verbatim, including the `key:` line and any continuation beneath it */
  lines: string[]
}

interface ParsedAgentFile {
  entries: FrontmatterEntry[]
  body: string
}

/**
 * Split a file into ordered frontmatter entries and its body.
 *
 * Line-based rather than a YAML parse, and deliberately so: the goal is not to
 * understand every key but to **hand back the ones we don't model untouched**.
 * A real parse would normalise quoting, comments and ordering across the whole
 * file, so saving an agent would rewrite lines the user never edited.
 */
function splitAgentFile(md: string): ParsedAgentFile {
  const m = md.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return { entries: [], body: md }
  const entries: FrontmatterEntry[] = []
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:\s|$)/)
    if (kv) entries.push({ key: kv[1], lines: [line] })
    // A continuation (folded scalar, block sequence) belongs to the key above
    else if (entries.length > 0) entries[entries.length - 1].lines.push(line)
    // Anything before the first key is malformed YAML and is dropped
  }
  return { entries, body: md.slice(m[0].length) }
}

/**
 * A YAML scalar that means exactly what it says.
 *
 * Quoting is the default rather than the exception: descriptions are prose and
 * routinely carry `:`, `,` and `#`, each of which changes the meaning of an
 * unquoted value. Newlines are folded to spaces — a description is one line by
 * construction, and a stray one would silently end the value.
 */
function scalar(value: string): string {
  const s = value.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (s === '') return "''"
  if (/^[A-Za-z0-9][A-Za-z0-9 _./()+-]*$/.test(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const flowList = (items: string[]): string => `[${items.map(scalar).join(', ')}]`

/**
 * Agent name → the slug that is both its invocation handle (`@name`) and its
 * filename.
 *
 * This value can come from a model, so it is sanitised the way
 * `slugifyBranch` sanitises a task: an apostrophe is an elision and is dropped
 * rather than split on (or `picker's` becomes `picker-s`), everything else
 * non-alphanumeric collapses to a single hyphen, and the result cannot contain
 * a separator or a leading dot — so it can never escape the agents directory
 * however it was written.
 */
export function sanitizeAgentName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

/** `<name>.md`, or a thrown error if nothing sluggable survived. */
export function agentFileName(name: string): string {
  const slug = sanitizeAgentName(name)
  if (!slug) throw new Error(`agent name has no usable characters: ${name}`)
  return `${slug}.md`
}

/** The frontmatter lines for one modelled key, or null to omit it entirely. */
function emit(key: (typeof MODELLED)[number], draft: AgentDraft): string | null {
  switch (key) {
    case 'name':
      return `name: ${scalar(sanitizeAgentName(draft.name))}`
    case 'description':
      return `description: ${scalar(draft.description)}`
    case 'model':
      return draft.model ? `model: ${scalar(draft.model)}` : null
    case 'effort':
      return draft.effort ? `effort: ${scalar(draft.effort)}` : null
    case 'color':
      return draft.color ? `color: ${scalar(draft.color)}` : null
    case 'tools':
      // An empty allowlist grants every tool, so omitting the key and writing
      // `tools: []` are opposites — the second is an agent that can do nothing.
      return draft.tools.length > 0 ? `tools: ${flowList(draft.tools)}` : null
    case 'disallowedTools':
      return draft.disallowedTools.length > 0
        ? `disallowedTools: ${flowList(draft.disallowedTools)}`
        : null
    case 'skills': {
      const preloaded = draft.skills.filter((s) => s.preload).map((s) => s.name)
      return preloaded.length > 0 ? `skills: ${flowList(preloaded)}` : null
    }
  }
}

/**
 * Draft → file text. Pass the original text when saving over an existing agent
 * and every frontmatter key this app does not model (`permissionMode`,
 * `maxTurns`, `mcpServers`, `hooks`, anything a CLI update adds) is carried
 * through in its original position and spelling.
 *
 * Without that, editing an agent in Chewo would quietly strip whatever the CLI
 * grew since this file was written — the failure mode being that the agent
 * still loads, so nobody notices until it behaves differently.
 */
export function serializeAgent(draft: AgentDraft, existing?: string): string {
  const parsed = existing ? splitAgentFile(existing) : { entries: [], body: '' }
  const modelled = new Set<string>(MODELLED)
  const written = new Set<string>()
  const lines: string[] = []

  for (const entry of parsed.entries) {
    if (!modelled.has(entry.key)) {
      lines.push(...entry.lines)
      continue
    }
    if (written.has(entry.key)) continue // a duplicate key; keep the first only
    written.add(entry.key)
    const next = emit(entry.key as (typeof MODELLED)[number], draft)
    if (next !== null) lines.push(next)
  }
  for (const key of MODELLED) {
    if (written.has(key)) continue
    const next = emit(key, draft)
    if (next !== null) lines.push(next)
  }

  const body = draft.systemPrompt.replace(/\s+$/, '')
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`
}

/**
 * File text → draft, for the edit path.
 *
 * Reuses the scanner's frontmatter reader rather than a second one, so an
 * agent reads the same in the editor as it does in the Agents tab — including
 * block sequences, folded scalars and inline lists, all three of which appear
 * in agents found in the wild.
 */
export function draftFromFile(md: string): AgentDraft {
  const fm = parseFrontmatter(md)
  const { body } = splitAgentFile(md)
  return {
    name: fm.name ?? '',
    description: fm.description ?? '',
    systemPrompt: body.replace(/^\s*\n/, '').replace(/\s+$/, ''),
    model: fm.model || undefined,
    effort: fm.effort || undefined,
    color: fm.color || undefined,
    tools: splitList(fm.tools),
    disallowedTools: splitList(fm.disallowedTools),
    // Anything already in `skills:` is preloaded by definition — that is what
    // the key means. Reasons are not on disk, so an edited agent shows none.
    skills: splitList(fm.skills).map((name) => ({
      name,
      reason: '',
      preload: true,
      installed: true
    }))
  }
}
