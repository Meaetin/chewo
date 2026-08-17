/**
 * How a subagent is recognised at a glance: two initials and a colour.
 *
 * Deliberately not an avatar image. Neither CLI's agent format has a field for
 * one, so a picture would have to live in a Chewo-side mapping that a copied
 * agent leaves behind — and the job here is only to tell three running agents
 * apart in a list, which initials and a hue already do. Same reasoning as the
 * `Badge` primitive marking Claude from Codex.
 *
 * Pure and DOM-free like `branch-names.ts` and `elapsed.ts`.
 */

/**
 * The named colours Claude Code's `color` frontmatter accepts, as hues.
 *
 * Mapped to hue angles rather than hex so a colour and a generated one are the
 * same kind of value and sit at the same saturation — a declared `red` next to
 * a hashed hue should look like it belongs to the same set.
 */
const NAMED_HUES: Record<string, number> = {
  red: 2,
  orange: 28,
  yellow: 48,
  green: 142,
  cyan: 187,
  blue: 217,
  purple: 271,
  pink: 330
}

/** Split a handle into its words: `figma-expert`, `QA Chris`, `api_reviewer`. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase reads as two words
    .split(/[\s\-_/.]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
}

/**
 * Two characters that stay distinct across a list of agents.
 *
 * One word gives its first two letters (`figma` → FI) rather than one, because
 * a single letter collides constantly — half a plugin marketplace starts with
 * the same letter.
 */
export function agentInitials(name: string): string {
  const parts = words(name)
  if (parts.length === 0) return '??'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/**
 * A stable hue for a name — the same agent is the same colour in every pane,
 * every session, with nothing stored.
 *
 * FNV-1a rather than a sum of char codes: a sum gives anagrams and same-length
 * names neighbouring hues, which is exactly the set of names that most needs
 * telling apart (`figma-expert` / `figma-explore`).
 */
export function agentHue(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 360
}

export interface AgentIdentity {
  initials: string
  /** A CSS colour, ready for a border or a text tint */
  color: string
  /** The same hue at low alpha, for a chip's fill */
  background: string
}

/**
 * `declared` is the agent's own `color` frontmatter when it set one; anything
 * unrecognised falls through to the hashed hue rather than to a default
 * colour, so an agent never silently shares grey with every other agent.
 */
export function agentIdentity(name: string, declared?: string): AgentIdentity {
  const named = declared ? NAMED_HUES[declared.trim().toLowerCase()] : undefined
  const hue = named ?? agentHue(name)
  return {
    initials: agentInitials(name),
    color: `hsl(${hue} 62% 68%)`,
    background: `hsl(${hue} 62% 68% / 0.16)`
  }
}
