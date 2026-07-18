import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ChevronRight, ChevronUp, GitBranch, Play, Slash, X } from 'lucide-react'
import type { NormalizedMessage, SessionMeta } from '../../../shared/adapter/types'
import { Badge, Button, IconButton, Input } from './ui'

interface TranscriptViewProps {
  session: SessionMeta
  onResume: (session: SessionMeta) => void
}

const FIND_HIGHLIGHT = 'transcript-find'
const FIND_CURRENT = 'transcript-find-current'

/** All matches of `query` as Ranges over the container's text nodes. */
function findMatches(container: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? ''
    let idx = text.indexOf(q)
    while (idx !== -1) {
      const range = new Range()
      range.setStart(node, idx)
      range.setEnd(node, idx + q.length)
      ranges.push(range)
      idx = text.indexOf(q, idx + q.length)
    }
  }
  return ranges
}

function clearHighlights(): void {
  CSS.highlights?.delete(FIND_HIGHLIGHT)
  CSS.highlights?.delete(FIND_CURRENT)
}

export function TranscriptView({ session, onResume }: TranscriptViewProps): React.JSX.Element {
  const [messages, setMessages] = useState<NormalizedMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set())
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentMatch, setCurrentMatch] = useState(0)
  const messagesRef = useRef<HTMLDivElement>(null)
  const findBarRef = useRef<HTMLDivElement>(null)
  const rangesRef = useRef<Range[]>([])

  // The find field lives inside the Input primitive (no forwarded ref); reach
  // it through the bar container so ⌘F can select its text.
  const selectFindInput = (): void => findBarRef.current?.querySelector('input')?.select()

  const toggleResult = (i: number): void =>
    setExpandedResults((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // (2) Old sessions open at their most recent exchange, not the top
  useEffect(() => {
    if (!messages) return
    requestAnimationFrame(() => {
      const el = messagesRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [messages])

  // (1) ⌘F / Ctrl+F opens the find bar; Esc closes it
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setFindOpen(true)
        requestAnimationFrame(selectFindInput)
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [findOpen])

  const gotoMatch = useCallback((idx: number) => {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const clamped = ((idx % ranges.length) + ranges.length) % ranges.length
    setCurrentMatch(clamped)
    CSS.highlights?.set(FIND_CURRENT, new Highlight(ranges[clamped]))
    const el = ranges[clamped].startContainer.parentElement
    el?.scrollIntoView({ block: 'center' })
  }, [])

  // Recompute highlights when the query, messages, or expanded results change
  // (collapsed tool outputs are not in the DOM, so they are not searched)
  useEffect(() => {
    if (!findOpen || !findQuery.trim() || !messagesRef.current) {
      clearHighlights()
      rangesRef.current = []
      setMatchCount(0)
      return
    }
    const raf = requestAnimationFrame(() => {
      const container = messagesRef.current
      if (!container) return
      const ranges = findMatches(container, findQuery.trim())
      rangesRef.current = ranges
      setMatchCount(ranges.length)
      if (ranges.length > 0) {
        CSS.highlights?.set(FIND_HIGHLIGHT, new Highlight(...ranges))
        CSS.highlights?.set(FIND_CURRENT, new Highlight(ranges[0]))
        setCurrentMatch(0)
        ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center' })
      } else {
        clearHighlights()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [findOpen, findQuery, messages, expandedResults])

  useEffect(() => clearHighlights, []) // unmount cleanup

  useEffect(() => {
    let cancelled = false
    window.api
      .getSession({ source: session.source, filePath: session.filePath })
      .then((result: { messages: NormalizedMessage[] }) => {
        if (!cancelled) setMessages(result.messages)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [session.source, session.filePath])

  return (
    <div className="transcript-view">
      <header className="transcript-header">
        <div className="transcript-header-info">
          <h2 className="transcript-title">{session.title}</h2>
          <div className="transcript-meta">
            <Badge source={session.source} />
            {session.project && <span className="transcript-project">{session.project}</span>}
            {session.gitBranch && (
              <span className="transcript-branch">
                <GitBranch size={14} strokeWidth={1.75} />
                {session.gitBranch}
              </span>
            )}
          </div>
        </div>
        <Button
          intent="primary"
          onClick={() => onResume(session)}
          leadingIcon={<Play size={16} strokeWidth={1.75} />}
        >
          Resume
        </Button>
      </header>

      {findOpen && (
        <div className="find-bar" ref={findBarRef}>
          <div className="find-search">
            <Input
              variant="search"
              placeholder="Find in transcript…"
              value={findQuery}
              autoFocus
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') gotoMatch(currentMatch + (e.shiftKey ? -1 : 1))
              }}
            />
          </div>
          <span className="find-count">
            {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : findQuery ? '0/0' : ''}
          </span>
          <IconButton label="Previous match" onClick={() => gotoMatch(currentMatch - 1)}>
            <ChevronUp size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Next match" onClick={() => gotoMatch(currentMatch + 1)}>
            <ChevronDown size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Close find" onClick={() => setFindOpen(false)}>
            <X size={16} strokeWidth={1.75} />
          </IconButton>
        </div>
      )}

      <div className="transcript-messages" ref={messagesRef}>
        {error && <div className="transcript-error">{error}</div>}
        {!messages && !error && <div className="transcript-loading">Loading…</div>}
        {messages?.map((m, i) => (
          <div key={i} className={`message message-${m.role}`}>
            {m.commandName ? (
              <div className="command-chip" title="Slash command">
                <Slash className="command-chip-symbol" size={12} strokeWidth={1.75} />
                <code>{m.commandName}</code>
              </div>
            ) : m.role === 'tool' ? (
              <div className="tool-call-block">
                <div
                  className={`tool-call-chip ${m.toolResult ? 'tool-call-chip-expandable' : ''}`}
                  onClick={m.toolResult ? () => toggleResult(i) : undefined}
                  title={m.toolResult ? 'Show tool output' : undefined}
                >
                  {m.toolResult && (
                    <span className="tool-call-chevron">
                      {expandedResults.has(i) ? (
                        <ChevronDown size={14} strokeWidth={1.75} />
                      ) : (
                        <ChevronRight size={14} strokeWidth={1.75} />
                      )}
                    </span>
                  )}
                  <span className="tool-call-name">{m.toolName}</span>
                  {m.text && <code className="tool-call-detail">{m.text.slice(0, 160)}</code>}
                </div>
                {m.toolResult && expandedResults.has(i) && (
                  <pre className="tool-result-output">{m.toolResult}</pre>
                )}
              </div>
            ) : m.role === 'assistant' ? (
              <>
                <div className="message-role-label">assistant</div>
                <div className="message-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                </div>
              </>
            ) : (
              // User text stays literal — pasted code/logs must not be
              // reinterpreted as markdown
              <>
                <div className="message-role-label">user</div>
                <div className="message-text">{m.text}</div>
              </>
            )}
          </div>
        ))}
        {messages?.length === 0 && <div className="transcript-loading">No messages</div>}
      </div>
    </div>
  )
}
