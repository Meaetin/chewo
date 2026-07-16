/**
 * Machine-injected content detection, shared by both parsers.
 *
 * Both CLIs inject pseudo-XML blocks as fake "user" messages —
 * <command-name>, <local-command-caveat>, <permissions instructions>,
 * <environment_context>, <user_instructions>, … The set grows with every
 * CLI release, so instead of a prefix list we use the shape: real humans
 * essentially never START a message with an XML-ish tag.
 */
const INJECTED_TAG_RE = /^<[a-z][\w-]*[\s>]/i

export function isInjectedNoise(text: string): boolean {
  return INJECTED_TAG_RE.test(text.trimStart())
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
