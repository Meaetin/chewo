import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Play } from 'lucide-react'
import { placeMenu } from '../selectPlacement'
import { useGitDirtyCount } from '../useGitStatus'
import { Badge, Dot } from './ui'

export interface TabMenuItem {
  /** Stable key — `t{termId}` for a live pane, `d{sessionId}` for a dormant one */
  id: string
  label: string
  source: 'claude' | 'codex' | 'shell'
  /** Has a process behind it */
  live: boolean
  /** Remembered from a previous app run — opening it resumes */
  dormant: boolean
  /** The pane currently on screen */
  active: boolean
  /** This session's worktree, for the uncommitted-changes pill */
  root?: string | null
  onSelect: () => void
}

/** Same passive poll as the tab's own pill — the menu is open for seconds. */
function MenuDirtyPill({ root }: { root: string | null }): React.JSX.Element | null {
  const count = useGitDirtyCount(root)
  if (count === 0) return null
  return (
    <span
      className="tab-overflow-dirty"
      title={`${count} uncommitted change${count === 1 ? '' : 's'} in this worktree`}
    >
      {count}
    </span>
  )
}

/**
 * The ⌄ button plus its menu: every open session in one list, reachable in a
 * click, with room for the labels the tabs had to truncate.
 *
 * The strip shrinks its tabs to a floor and only then scrolls, so past a
 * certain count a session is not merely narrow, it is off-screen — and with
 * the scrollbar hidden there is nothing to say so. This is the completeness
 * guarantee for that state, which is why it appears only when the strip is
 * actually hiding something: a permanently visible control would cost the tabs
 * the width it exists to give back.
 */
export function TabOverflowButton({
  items,
  hidden
}: {
  items: TabMenuItem[]
  /** How many tabs are off-screen right now — the badge on the button */
  hidden: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const close = (): void => setOpen(false)
    // Capture, so closing the menu doesn't also reach the pane's own Escape
    // handler and interrupt whatever the focused agent is saying.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    setRect(r)
    setOpen(true)
  }

  // Safe to read the viewport during render: the rect is captured on open and
  // a resize closes the menu, so neither can go stale while it is up.
  const position =
    open && rect
      ? placeMenu(rect, 280, { width: window.innerWidth, height: window.innerHeight })
      : null

  const label =
    hidden > 0
      ? `${hidden} session${hidden === 1 ? '' : 's'} off-screen — show all ${items.length}`
      : `All open sessions (${items.length})`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`tab-overflow-button ${open ? 'tab-overflow-button-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={toggle}
      >
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
        {hidden > 0 && <span className="tab-overflow-count">{hidden}</span>}
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            className="tab-overflow-menu"
            role="menu"
            style={{
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight
            }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={`tab-overflow-item ${item.active ? 'tab-overflow-item-active' : ''}`}
                onClick={() => {
                  item.onSelect()
                  setOpen(false)
                }}
              >
                <span className="tab-overflow-state">
                  {item.dormant ? (
                    <Play className="tab-overflow-ghost" size={12} strokeWidth={1.75} />
                  ) : item.live ? (
                    <Dot tone="live" />
                  ) : null}
                </span>
                <Badge source={item.source} />
                <span
                  className={`tab-overflow-label ${item.dormant ? 'tab-overflow-label-dormant' : ''}`}
                >
                  {item.label}
                </span>
                {item.root ? <MenuDirtyPill root={item.root} /> : null}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
