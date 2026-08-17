import { sanitizeAgentName, type AgentDraft } from './agent-file'

/**
 * The builder's request, its answer, and everything pure in between: the JSON
 * Schema the CLI is held to, the prompt, and the reconciliation of what comes
 * back against the real inventory.
 *
 * Split from `main/agent-builder.ts` because that file reaches Settings and so
 * imports electron — which puts it out of reach of both the renderer and the
 * canary. What is left in main is the spawn: a timeout, a cwd and a model pin.
 */

/**
 * Enough that a machine with a large marketplace installed still offers the
 * model a real choice, bounded so a pathological install can't blow the
 * prompt. Descriptions are the routing text and are clipped, not dropped —
 * a name alone doesn't say what a skill is for.
 */
const MAX_SKILLS = 200
const MAX_SKILL_DESC = 240


/** A skill the draft is allowed to choose from. */
export interface SkillOption {
  name: string
  description: string
  /** Human-readable provenance, e.g. "personal" or "figma plugin" */
  origin: string
  /**
   * Reachable by an agent *right now* — which is not the same as present on
   * disk. A disabled plugin's skills are installed and reach nobody, and that
   * is the case the inventory exists to make visible, so they are offered
   * with this false rather than hidden.
   */
  installed: boolean
  /** Why it isn't reachable, in the words to show the user */
  unavailableReason?: string
  /** `<plugin>@<marketplace>`, when installing it is a possibility */
  pluginId?: string
  /** SKILL.md size — what preloading this one would cost, per invocation */
  bytes?: number
}

/**
 * Bytes → an honest-enough token count for a preload budget.
 *
 * Four characters per token is the usual English rule of thumb, and the
 * precision that matters here is "hundreds or tens of thousands", not the
 * exact figure — the decision the number informs is whether to preload at all.
 */
export const approxTokens = (bytes: number): number => Math.round(bytes / 4)

export interface DraftRequest {
  /** What the user typed */
  request: string
  skills: SkillOption[]
  /** Existing agents, so a new one doesn't collide with a live router */
  existing: Array<{ name: string; description: string }>
}

export type DraftResult = { ok: true; draft: AgentDraft } | { ok: false; error: string }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

/**
 * Model output → draft, reconciled against the real inventory.
 *
 * Two things this must do beyond reading fields. A skill name the model
 * invented is **dropped**, not carried: an unknown name in `skills:` is a
 * preload that fails at spawn, and the user has no way to tell a hallucinated
 * skill from one they simply haven't installed. And `preload` is forced off
 * whatever the model says — preloading is a per-run context cost measured in
 * tens of thousands of tokens, so it is the user's call on the review screen,
 * not the drafting model's.
 *
 * Exported for testing; the shape is a model's, so it is read defensively.
 */
export function readDraft(raw: Record<string, unknown>, offered: SkillOption[]): AgentDraft {
  const known = new Map(offered.map((s) => [s.name, s]))
  const name = sanitizeAgentName(str(raw.name))
  if (!name) throw new Error('The agent builder returned no usable name.')
  const description = str(raw.description)
  const systemPrompt = str(raw.systemPrompt)
  if (!description || !systemPrompt)
    throw new Error('The agent builder returned an incomplete draft.')

  const chosen = Array.isArray(raw.skills) ? raw.skills : []
  const seen = new Set<string>()
  const skills: AgentDraft['skills'] = []
  for (const entry of chosen) {
    if (!entry || typeof entry !== 'object') continue
    const skillName = str((entry as Record<string, unknown>).name)
    const found = known.get(skillName)
    if (!found || seen.has(skillName)) continue
    seen.add(skillName)
    skills.push({
      name: skillName,
      reason: str((entry as Record<string, unknown>).reason),
      preload: false,
      installed: found.installed,
      pluginId: found.pluginId
    })
  }

  return {
    name,
    description,
    systemPrompt,
    model: str(raw.model) || undefined,
    effort: str(raw.effort) || undefined,
    tools: strings(raw.tools),
    disallowedTools: strings(raw.disallowedTools),
    skills
  }
}

export const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Lowercase hyphenated handle, 2-4 words, e.g. api-reviewer'
    },
    description: {
      type: 'string',
      description:
        'One or two sentences naming the situations this agent should be delegated to. This is the router.'
    },
    systemPrompt: {
      type: 'string',
      description:
        'The complete system prompt in markdown. The agent inherits nothing, so this must stand alone.'
    },
    model: {
      type: ['string', 'null'],
      description: 'One of opus, sonnet, haiku, fable, or null to inherit the session model'
    },
    effort: {
      type: ['string', 'null'],
      description: 'One of low, medium, high, xhigh, max, or null to inherit'
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Allowlist. Leave empty to grant every tool; only narrow it for a real reason.'
    },
    disallowedTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Denylist, e.g. Write and Edit for a review-only agent'
    },
    skills: {
      type: 'array',
      description: 'Skills chosen from the offered list only',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          reason: { type: 'string', description: 'Why this agent needs it, one sentence' }
        },
        required: ['name', 'reason']
      }
    }
  },
  required: ['name', 'description', 'systemPrompt']
})

export function buildPrompt(req: DraftRequest): string {
  const skills = req.skills
    .slice(0, MAX_SKILLS)
    .map((s) => `- ${s.name} (${s.origin}): ${s.description.slice(0, MAX_SKILL_DESC)}`)
  const existing = req.existing.map((a) => `- ${a.name}: ${a.description}`)
  return [
    'Design a Claude Code subagent from this request. Reply only through the schema.',
    '',
    '--- the request ---',
    req.request,
    '',
    'Rules that matter:',
    '',
    '1. `description` is the router — it is the only thing the main agent reads',
    '   when deciding whether to hand work over. Name the situations, not the',
    '   qualities. "Use when reviewing a diff for security issues before merge"',
    '   routes; "an expert security reviewer" does not.',
    '2. `systemPrompt` is the ENTIRE system prompt. A subagent inherits nothing,',
    '   so state the role, how to approach the work, what to check, and what to',
    '   return. Write it for the agent, not about it. No preamble, no headings',
    '   that just restate the name.',
    '3. Model: opus for architecture, security and review; sonnet for docs,',
    '   tests and debugging; haiku for fast mechanical work; fable for long',
    '   autonomous runs. Return null to inherit the session model, which is the',
    '   right answer for general domain work.',
    '4. Tools: leave the allowlist empty unless narrowing it serves the role.',
    '   Prefer a denylist for a read-only agent (disallow Write, Edit).',
    '5. Skills: choose ONLY from the list below, by exact name, and only ones',
    '   this agent would genuinely reach for. Give a one-sentence reason for',
    '   each. Choosing none is a fine answer.',
    '',
    skills.length ? '--- skills available ---' : '--- no skills available ---',
    ...skills,
    '',
    existing.length ? '--- agents that already exist (do not duplicate their routing) ---' : '',
    ...existing
  ]
    .filter((line) => line !== '')
    .join('\n')
}
