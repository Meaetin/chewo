/**
 * The frontmatter subset both a scan and an edit need, kept **free of node
 * imports** so it can run in the renderer.
 *
 * It used to live in `scan.ts`, which reads directories and therefore imports
 * `node:fs` — importing a parser from there would have pulled the filesystem
 * into the renderer bundle, the same trap `shared/chewo-mcp.ts` documents.
 * The agent editor previews a file as it will be written, so it needs these.
 */

export const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, '')

/**
 * YAML frontmatter subset: `key: value`, folded scalars (`>-`, `|`), and
 * block sequences.
 *
 * Block sequences are collapsed to a comma-joined string rather than widening
 * the return type, so every existing caller keeps working and `splitList`
 * below is the single place that turns any of the three list spellings back
 * into an array. Agent frontmatter needs this: `tools` is usually inline
 * (`tools: Read, Grep`) but `skills` is conventionally written as a block
 * list, and dropping it silently would under-report an agent's real context
 * cost — the exact thing the Agents tab exists to show.
 */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  let key: string | null = null
  let folded = false
  // Only a key introduced with an empty value can collect `- item` lines; a
  // key with an inline value followed by a dash is malformed, not a list.
  let listMode = false
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) {
      key = kv[1]
      const v = kv[2].trim()
      folded = v === '>-' || v === '>' || v === '|' || v === '|-'
      listMode = v === ''
      out[key] = folded ? '' : unquote(v)
      continue
    }
    const item = line.match(/^\s*-\s+(.*\S)\s*$/)
    if (key && listMode && item) {
      const value = unquote(item[1])
      out[key] = out[key] ? `${out[key]}, ${value}` : value
      continue
    }
    if (key && folded && /^\s+\S/.test(line)) {
      out[key] = (out[key] ? out[key] + ' ' : '') + line.trim()
    }
  }
  return out
}

/** `a, b` / `[a, b]` / a collapsed block sequence → `['a', 'b']`. */
export function splitList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(unquote)
    .filter(Boolean)
}
