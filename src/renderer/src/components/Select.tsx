import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'
import { filterOptions } from '../selectFilter'
import { placeMenu } from '../selectPlacement'

export interface SelectOption<T extends string> {
  value: T
  label: string
  detail?: string
  /**
   * Heading this option sits under. A header is drawn whenever the group
   * changes between two consecutive *shown* rows, so filtering never strands a
   * heading over an empty section and never repeats one. Options are rendered
   * in the order given — grouping is a label, not a sort, so a caller that
   * interleaves groups gets exactly what it asked for.
   */
  group?: string
}

interface SelectProps<T extends string> {
  id?: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  /**
   * Adds a filter box above the list. Opt-in rather than automatic: most
   * pickers here hold a handful of items, where a search field is noise. Turn
   * it on for the long, unbounded lists (Deepgram's per-model languages).
   */
  searchable?: boolean
  /** Placeholder for the filter box; only read when `searchable`. */
  searchPlaceholder?: string
  /** Extra class on the trigger — for a compact variant, e.g. in the composer */
  className?: string
  /**
   * Floor for the menu's width. The menu otherwise matches the trigger, which
   * is right for a settings row and far too narrow for a trigger shrunk to fit
   * its own label.
   */
  menuMinWidth?: number
}

/**
 * Custom select. A native <select> on macOS pops its menu *over* the field,
 * aligned to the selected item, and its arrow position is UA-controlled —
 * neither is reachable from CSS. This opens below the field, or above it when
 * there is no room below (see `selectPlacement.ts`).
 *
 * The menu is portalled to <body> because the modal body scrolls
 * (overflow-y: auto), which would clip an absolutely-positioned child.
 */
export function Select<T extends string>({
  id,
  value,
  options,
  onChange,
  searchable = false,
  searchPlaceholder = 'Search…',
  className,
  menuMinWidth
}: SelectProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Never fall back to options[0]: when the value isn't in the list that shows
  // a *different* option as though it were the setting, which reads as the app
  // silently changing it. Show the raw value instead — it is at least true.
  const selected = options.find((o) => o.value === value)

  const shown = useMemo(
    () => (searchable ? filterOptions(options, query) : options),
    [options, query, searchable]
  )

  const openMenu = (): void => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    setRect(r)
    setQuery('')
    setActiveIndex(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  // Typing should start filtering immediately, without a second click.
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
  }, [open, searchable])

  const commit = (v: T): void => {
    onChange(v)
    setOpen(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const close = (): void => setOpen(false)
    // An ancestor scrolling would drift the fixed-positioned menu, so close —
    // but scrolling the menu's own list must not close it.
    const onScroll = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'Escape') {
      // Keep Esc from reaching the modal shell, which would close the dialog
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(shown.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const option = shown[activeIndex]
      if (option) commit(option.value)
    } else if (e.key === ' ' && !searchable) {
      // Space picks the active option, but in a filter box it is just a space.
      e.preventDefault()
      const option = shown[activeIndex]
      if (option) commit(option.value)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  // Safe to read the viewport during render: the rect is captured on open and
  // a resize closes the menu, so neither can go stale while it is up.
  const position = rect
    ? placeMenu(rect, menuMinWidth ?? 0, { width: window.innerWidth, height: window.innerHeight })
    : null

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={`wt-select-trigger ${open ? 'wt-select-trigger-open' : ''}${className ? ` ${className}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="wt-select-value">{selected?.label ?? value}</span>
        <ChevronDown className="wt-select-chevron" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            className="wt-select-menu"
            role="listbox"
            style={{
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight
            }}
          >
            {searchable && (
              <div className="wt-select-search">
                <Search size={13} strokeWidth={1.75} aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="text"
                  className="wt-select-search-input"
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.currentTarget.value)
                    // The old index points into the previous list; anything but
                    // 0 would highlight an unrelated row.
                    setActiveIndex(0)
                  }}
                  onKeyDown={onKeyDown}
                />
              </div>
            )}

            <div className="wt-select-options">
              {shown.map((o, i) => (
                <Fragment key={o.value}>
                  {o.group && o.group !== shown[i - 1]?.group && (
                    // Presentational: keeping the rows a flat list of options is
                    // what lets arrow-key navigation stay indexed on `shown`.
                    <div className="wt-select-group" role="presentation">
                      {o.group}
                    </div>
                  )}
                  <div
                    role="option"
                    aria-selected={o.value === value}
                    className={`wt-select-option ${i === activeIndex ? 'wt-select-option-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => commit(o.value)}
                  >
                    <span className="wt-select-check">
                      {o.value === value && <Check size={14} strokeWidth={2} aria-hidden="true" />}
                    </span>
                    <span className="wt-select-option-text">
                      <span className="wt-select-option-label">{o.label}</span>
                      {o.detail && <span className="wt-select-option-detail">{o.detail}</span>}
                    </span>
                  </div>
                </Fragment>
              ))}
              {shown.length === 0 && <div className="wt-select-empty">No matches</div>}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
