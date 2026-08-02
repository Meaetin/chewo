import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { IconButton, Input } from '../ui'

/**
 * Find-in-conversation. Lifted out of the old transcript view when clicking a
 * session started resuming it directly — a resumed pane can hold hundreds of
 * messages, so this is more necessary here than it was there.
 *
 * Matches are painted with the CSS Custom Highlight API rather than by
 * wrapping text in elements: the thread is live markdown that re-renders on
 * every token, and mutating it to insert <mark>s would fight the reconciler.
 * Highlights are ranges over text nodes, so they survive re-render and cost
 * nothing to clear.
 */

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

interface FindBarProps {
  /** The scroll container to search within */
  containerRef: React.RefObject<HTMLElement | null>
  /** Only the visible pane may claim ⌘F — panes stay mounted while hidden */
  active: boolean
  /** Re-run the search when the thread changes under it */
  revision: unknown
  /** Fired when the bar opens, so the pane can render everything first */
  onOpen?: () => void
}

export function FindBar({ containerRef, active, revision, onOpen }: FindBarProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const rangesRef = useRef<Range[]>([])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setOpen(true)
        onOpen?.()
        requestAnimationFrame(() => inputRef.current?.select())
      } else if (e.key === 'Escape' && open) {
        // Claimed before the pane's own Escape-to-interrupt, so closing the
        // find bar never also stops the agent
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, open, onOpen])

  const goto = useCallback((idx: number) => {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const clamped = ((idx % ranges.length) + ranges.length) % ranges.length
    setCurrent(clamped)
    CSS.highlights?.set(FIND_CURRENT, new Highlight(ranges[clamped]))
    ranges[clamped].startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [])

  useEffect(() => {
    if (!open || !query.trim() || !containerRef.current) {
      clearHighlights()
      rangesRef.current = []
      setMatchCount(0)
      return
    }
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container) return
      const ranges = findMatches(container, query.trim())
      rangesRef.current = ranges
      setMatchCount(ranges.length)
      if (ranges.length > 0) {
        CSS.highlights?.set(FIND_HIGHLIGHT, new Highlight(...ranges))
        CSS.highlights?.set(FIND_CURRENT, new Highlight(ranges[0]))
        setCurrent(0)
        ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center' })
      } else {
        clearHighlights()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [open, query, revision, containerRef])

  useEffect(() => clearHighlights, []) // unmount cleanup
  useEffect(() => {
    if (!active) clearHighlights()
  }, [active])

  if (!open) return null

  return (
    <div className="find-bar">
      <div className="find-search">
        <Input
          ref={inputRef}
          variant="search"
          placeholder="Find in conversation…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') goto(current + (e.shiftKey ? -1 : 1))
          }}
        />
      </div>
      <span className="find-count">
        {matchCount > 0 ? `${current + 1}/${matchCount}` : query ? '0/0' : ''}
      </span>
      <IconButton label="Previous match" onClick={() => goto(current - 1)}>
        <ChevronUp size={16} strokeWidth={1.75} />
      </IconButton>
      <IconButton label="Next match" onClick={() => goto(current + 1)}>
        <ChevronDown size={16} strokeWidth={1.75} />
      </IconButton>
      <IconButton label="Close find" onClick={() => setOpen(false)}>
        <X size={16} strokeWidth={1.75} />
      </IconButton>
    </div>
  )
}
