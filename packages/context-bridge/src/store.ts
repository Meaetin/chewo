import { loadSession, scanAll } from '../../../src/shared/adapter'
import type { ParseResult, SessionMeta, Source } from '../../../src/shared/adapter'

export interface StoreOptions {
  claudeRoot?: string
  codexRoot?: string
}

export interface SearchCandidate {
  id: string
  source: Source
  title: string
  project: string | null
  updatedAt: string
  preview: string
  messageCount: number
}

function toCandidate(s: SessionMeta): SearchCandidate {
  return {
    id: s.id,
    source: s.source,
    title: s.title,
    project: s.project,
    updatedAt: s.updatedAt,
    preview: s.preview,
    messageCount: s.messageCount
  }
}

function projectName(project: string | null): string {
  return project?.split('/').pop()?.toLowerCase() ?? ''
}

/**
 * Fuzzy ranking over titles + previews + project names. Deliberately returns
 * a candidate LIST — titles are auto-generated and collide, so the calling
 * model disambiguates rather than this code silently guessing.
 */
export function searchSessions(
  query: string,
  opts: { source?: Source; project?: string; limit?: number } & StoreOptions = {}
): SearchCandidate[] {
  const { sessions } = scanAll(opts)
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const phrase = query.toLowerCase().trim()

  const scored = sessions
    .filter((s) => !opts.source || s.source === opts.source)
    .filter((s) => !opts.project || projectName(s.project).includes(opts.project.toLowerCase()))
    .map((s) => {
      const title = s.title.toLowerCase()
      const preview = s.preview.toLowerCase()
      const proj = projectName(s.project)
      let score = 0
      for (const tok of tokens) {
        if (title.includes(tok)) score += 3
        if (preview.includes(tok)) score += 1
        if (proj.includes(tok)) score += 2
      }
      if (phrase.length > 3 && title.includes(phrase)) score += 5
      return { s, score }
    })
    .filter((x) => x.score > 0)

  scored.sort((a, b) => b.score - a.score || b.s.updatedAt.localeCompare(a.s.updatedAt))
  return scored.slice(0, opts.limit ?? 5).map((x) => toCandidate(x.s))
}

export function listRecentSessions(
  opts: { source?: Source; project?: string; limit?: number } & StoreOptions = {}
): SearchCandidate[] {
  const { sessions } = scanAll(opts)
  return sessions
    .filter((s) => !opts.source || s.source === opts.source)
    .filter((s) => !opts.project || projectName(s.project).includes(opts.project.toLowerCase()))
    .slice(0, opts.limit ?? 10)
    .map(toCandidate)
}

export function getSessionById(id: string, opts: StoreOptions = {}): ParseResult | null {
  const { sessions } = scanAll(opts)
  const meta = sessions.find((s) => s.id === id)
  if (!meta) return null
  return loadSession(meta.source, meta.filePath, opts)
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max) + ' …[truncated]'

/**
 * Cheap-but-effective digest: title + every user message + final assistant
 * message + files touched. ~90% of useful cross-session context at ~2% of
 * the tokens. Hard-capped: drops middle user messages first when over budget.
 */
export function digestSession(result: ParseResult, maxChars = 8000): string {
  const { meta, messages } = result
  const header = [
    `# ${meta.title}`,
    `source: ${meta.source} | project: ${meta.project ?? 'unknown'} | updated: ${meta.updatedAt}`,
    `session id: ${meta.id}`
  ].join('\n')

  const userMsgs = messages.filter((m) => m.role === 'user')
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const files = [...new Set(messages.flatMap((m) => m.filesTouched ?? []))]

  const buildBody = (users: typeof userMsgs, omitted: number): string => {
    const parts: string[] = []
    users.forEach((m, i) => {
      parts.push(`## User ${i + 1}\n${truncate(m.text, 600)}`)
      if (omitted > 0 && i === 0) parts.push(`…[${omitted} earlier user messages omitted]`)
    })
    if (lastAssistant) parts.push(`## Final assistant reply\n${truncate(lastAssistant.text, 1500)}`)
    if (files.length) parts.push(`## Files touched\n${files.slice(0, 40).join('\n')}`)
    return parts.join('\n\n')
  }

  let kept = userMsgs
  let omitted = 0
  let body = buildBody(kept, omitted)
  // Shrink by dropping middle user messages (keep first + most recent) until under cap
  while (header.length + body.length + 2 > maxChars && kept.length > 2) {
    omitted = userMsgs.length - (kept.length - 1)
    kept = [kept[0], ...kept.slice(2)]
    body = buildBody(kept, omitted)
  }
  return truncate(`${header}\n\n${body}`, maxChars)
}

export function tailSession(result: ParseResult, count = 12): string {
  const { meta, messages } = result
  const tail = messages.slice(-count)
  const lines = tail.map((m) =>
    m.role === 'tool'
      ? `[tool:${m.toolName}] ${truncate(m.text, 200)}`
      : `[${m.role}] ${truncate(m.text, 800)}`
  )
  return `# ${meta.title} (last ${tail.length} of ${messages.length} messages)\n\n${lines.join('\n\n')}`
}

export interface FullPage {
  page: number
  totalPages: number
  text: string
}

export function fullSessionPage(result: ParseResult, page = 1, pageChars = 8000): FullPage {
  const { meta, messages } = result
  const lines = messages.map((m) =>
    m.role === 'tool' ? `[tool:${m.toolName}] ${m.text}` : `[${m.role}] ${m.text}`
  )

  const pages: string[] = []
  let current = ''
  for (const line of lines) {
    const chunk = line.length > pageChars ? truncate(line, pageChars) : line
    if (current && current.length + chunk.length + 2 > pageChars) {
      pages.push(current)
      current = chunk
    } else {
      current = current ? `${current}\n\n${chunk}` : chunk
    }
  }
  if (current) pages.push(current)
  if (pages.length === 0) pages.push('(no messages)')

  const clamped = Math.min(Math.max(1, page), pages.length)
  return {
    page: clamped,
    totalPages: pages.length,
    text: `# ${meta.title} (page ${clamped}/${pages.length})\n\n${pages[clamped - 1]}`
  }
}
