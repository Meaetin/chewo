/**
 * Machine-injected content detection, shared by both parsers.
 *
 * Both CLIs inject pseudo-XML blocks as fake "user" messages —
 * <command-name>, <local-command-caveat>, <permissions instructions>,
 * <environment_context>, <user_instructions>, … The set grows with every
 * CLI release, so instead of a prefix list we use the shape: real humans
 * essentially never START a message with an XML-ish tag.
 */
const INJECTED_PATTERNS = [
  /^<[a-z][\w-]*[\s>]/i, // pseudo-XML blocks: <command-name>, <permissions instructions>, …
  /^# AGENTS\.md/i, // Codex injects AGENTS.md content under a markdown header, no tag
  /^You are\s+[`'"]?\/root[`'"]?,\s+the primary agent in a team of agents collaborating to fulfill the user's goals\./i
]

export function isInjectedNoise(text: string): boolean {
  const t = text.trimStart()
  return INJECTED_PATTERNS.some((re) => re.test(t))
}

/** Slash-command invocations are worth showing (compactly), unlike other noise. */
export function extractCommand(text: string): string | null {
  const m = text.match(/<command-name>([^<]*)<\/command-name>/)
  const name = m?.[1]?.trim()
  if (!name) return null
  const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

/** "Untitled · Jul 14" — last-resort title that is never a raw UUID. */
export function untitledFallback(createdAt: string): string {
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return 'Untitled session'
  return `Untitled · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}
