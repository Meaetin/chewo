import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  id: string
  label: string
  /** Right-aligned hint, e.g. '⌘C' */
  shortcut?: string
  disabled?: boolean
  danger?: boolean
}

export type ContextMenuEntry = ContextMenuItem | { separator: true }

interface ContextMenuProps {
  /** Viewport coordinates of the right-click */
  x: number
  y: number
  items: ContextMenuEntry[]
  onSelect: (id: string) => void
  onClose: () => void
}

const EDGE_GAP = 8

const isItem = (e: ContextMenuEntry): e is ContextMenuItem => !('separator' in e)

/**
 * Right-click menu, portalled to <body> so no ancestor's overflow clips it.
 * Opens at the pointer and flips back inside the viewport once measured.
 * Closes on Escape, outside pointer-down, scroll, resize, and window blur.
 */
export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose
}: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [activeIndex, setActiveIndex] = useState(-1)

  const selectable = items.filter((e) => isItem(e) && !e.disabled) as ContextMenuItem[]

  // Measure before paint so the menu never flashes off-screen
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP))
    })
    el.focus()
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    // mousedown (not contextmenu) so a right-click elsewhere dismisses this
    // menu before the new one opens — right-click fires mousedown first.
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  const step = (delta: number): void => {
    if (!selectable.length) return
    setActiveIndex((i) => {
      const next = i + delta
      if (next < 0) return selectable.length - 1
      if (next >= selectable.length) return 0
      return next
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = selectable[activeIndex]
      if (item) onSelect(item.id)
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) =>
        isItem(entry) ? (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={[
              'context-menu-item',
              entry.danger ? 'context-menu-item-danger' : '',
              !entry.disabled && selectable[activeIndex]?.id === entry.id
                ? 'context-menu-item-active'
                : ''
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={entry.disabled}
            onMouseEnter={() =>
              setActiveIndex(selectable.findIndex((s) => s.id === entry.id))
            }
            onClick={() => onSelect(entry.id)}
          >
            <span className="context-menu-label">{entry.label}</span>
            {entry.shortcut && <span className="context-menu-shortcut">{entry.shortcut}</span>}
          </button>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`sep-${i}`} className="context-menu-separator" role="separator" />
        )
      )}
    </div>,
    document.body
  )
}
