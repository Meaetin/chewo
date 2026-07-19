import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { EditorView, Panel, ViewUpdate } from '@uiw/react-codemirror'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery
} from '@codemirror/search'
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X
} from 'lucide-react'
import { IconButton, Input } from './ui'

interface QuerySpec {
  search: string
  replace: string
  caseSensitive: boolean
  regexp: boolean
  wholeWord: boolean
}

/** Matches beyond this aren't counted — the label shows "999+". */
const COUNT_CAP = 999

/** Keep focus in the find field while clicking panel buttons. */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

function countMatches(
  view: EditorView,
  spec: QuerySpec
): { current: number; total: number; capped: boolean } {
  const query = new SearchQuery(spec)
  if (!spec.search || !query.valid) return { current: 0, total: 0, capped: false }
  const sel = view.state.selection.main
  let total = 0
  let current = 0
  let capped = false
  try {
    const cursor = query.getCursor(view.state)
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      total++
      if (step.value.from <= sel.from) current = total
      if (total > COUNT_CAP) {
        capped = true
        break
      }
    }
  } catch {
    return { current: 0, total: 0, capped: false }
  }
  return { current, total, capped }
}

function FindPanel({
  view,
  handle
}: {
  view: EditorView
  handle: { onUpdate?: (u: ViewUpdate) => void }
}): React.JSX.Element {
  const [spec, setSpec] = useState<QuerySpec>(() => {
    const q = getSearchQuery(view.state)
    // Seed from the selection (the stock panel's behaviour we're replacing).
    const sel = view.state.selection.main
    const seeded =
      sel.empty || sel.to - sel.from > 100
        ? q.search
        : view.state.sliceDoc(sel.from, sel.to).replace(/\n/g, '')
    return {
      search: seeded,
      replace: q.replace,
      caseSensitive: q.caseSensitive,
      regexp: q.regexp,
      wholeWord: q.wholeWord
    }
  })
  const [showReplace, setShowReplace] = useState(false)
  const [tick, setTick] = useState(0)
  const findRef = useRef<HTMLInputElement>(null)

  // Doc edits and cursor moves shift the match set / current index.
  useEffect(() => {
    handle.onUpdate = (u) => {
      if (u.docChanged || u.selectionSet) setTick((t) => t + 1)
    }
    return () => {
      handle.onUpdate = undefined
    }
  }, [handle])

  // Push the (possibly selection-seeded) query into CM state on open, and on
  // every later change via commit().
  useEffect(() => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(spec)) })
    findRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, [])

  const commit = (next: QuerySpec): void => {
    setSpec(next)
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(next)) })
  }

  const invalidRegexp = useMemo(() => {
    if (!spec.regexp || !spec.search) return false
    try {
      new RegExp(spec.search)
      return false
    } catch {
      return true
    }
  }, [spec.regexp, spec.search])

  const { current, total, capped } = useMemo(
    () => countMatches(view, spec),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick tracks doc/selection
    [view, spec, tick]
  )

  const close = (): void => {
    closeSearchPanel(view)
    view.focus()
  }

  return (
    <div
      className="editor-find"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        } else if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          findRef.current?.select()
        }
      }}
    >
      <div className="editor-find__row">
        <IconButton
          label={showReplace ? 'Hide replace' : 'Replace'}
          dense
          className="editor-find__expand"
          active={showReplace}
          onMouseDown={keepFocus}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? (
            <ChevronDown size={14} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={14} strokeWidth={1.75} />
          )}
        </IconButton>
        <div className={`editor-find__field${invalidRegexp ? ' editor-find__field--invalid' : ''}`}>
          <Input
            ref={findRef}
            variant="search"
            mono
            placeholder="Find in file…"
            value={spec.search}
            autoFocus
            {...{ 'main-field': 'true' }}
            onChange={(e) => commit({ ...spec, search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.shiftKey ? findPrevious : findNext)(view)
              }
            }}
          />
        </div>
        <span className="find-count">
          {spec.search ? `${current}/${capped ? `${COUNT_CAP}+` : total}` : ''}
        </span>
        <IconButton
          label="Previous match"
          onMouseDown={keepFocus}
          onClick={() => findPrevious(view)}
        >
          <ChevronUp size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Next match" onMouseDown={keepFocus} onClick={() => findNext(view)}>
          <ChevronDown size={16} strokeWidth={1.75} />
        </IconButton>
        <span className="editor-find__sep" />
        <IconButton
          label="Match case"
          active={spec.caseSensitive}
          onMouseDown={keepFocus}
          onClick={() => commit({ ...spec, caseSensitive: !spec.caseSensitive })}
        >
          <CaseSensitive size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Regular expression"
          active={spec.regexp}
          onMouseDown={keepFocus}
          onClick={() => commit({ ...spec, regexp: !spec.regexp })}
        >
          <Regex size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Whole word"
          active={spec.wholeWord}
          onMouseDown={keepFocus}
          onClick={() => commit({ ...spec, wholeWord: !spec.wholeWord })}
        >
          <WholeWord size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Close find" onClick={close}>
          <X size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      {showReplace && (
        <div className="editor-find__row editor-find__row--replace">
          <div className="editor-find__field">
            <Input
              mono
              placeholder="Replace with…"
              value={spec.replace}
              autoFocus
              onChange={(e) => commit({ ...spec, replace: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  replaceNext(view)
                }
              }}
            />
          </div>
          <IconButton label="Replace" onMouseDown={keepFocus} onClick={() => replaceNext(view)}>
            <Replace size={15} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Replace all" onMouseDown={keepFocus} onClick={() => replaceAll(view)}>
            <ReplaceAll size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      )}
    </div>
  )
}

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'editor-find-host'
  const root = createRoot(dom)
  const handle: { onUpdate?: (u: ViewUpdate) => void } = {}
  root.render(<FindPanel view={view} handle={handle} />)
  return {
    dom,
    top: true,
    update(u) {
      handle.onUpdate?.(u)
    },
    destroy() {
      // CM removes the panel mid-update; React can't unmount synchronously here.
      queueMicrotask(() => root.unmount())
    }
  }
}

/** ⌘F search wired to the app's own find-bar look instead of CM's stock form. */
export const editorSearch = search({ top: true, createPanel: createFindPanel })
