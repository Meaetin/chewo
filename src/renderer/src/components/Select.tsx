import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption<T extends string> {
  value: T
  label: string
  detail?: string
}

interface SelectProps<T extends string> {
  id?: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
}

const MENU_GAP = 4
const MENU_MAX_HEIGHT = 260

/**
 * Custom select. A native <select> on macOS pops its menu *over* the field,
 * aligned to the selected item, and its arrow position is UA-controlled —
 * neither is reachable from CSS. This opens below the field instead.
 *
 * The menu is portalled to <body> because the modal body scrolls
 * (overflow-y: auto), which would clip an absolutely-positioned child.
 */
export function Select<T extends string>({
  id,
  value,
  options,
  onChange
}: SelectProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === value) ?? options[0]

  const openMenu = (): void => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    setRect(r)
    setActiveIndex(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

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
    // Any scroll/resize invalidates the captured rect — close rather than drift
    const close = (): void => setOpen(false)
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
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
      setActiveIndex((i) => Math.min(options.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(options[activeIndex].value)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={`wt-select-trigger ${open ? 'wt-select-trigger-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="wt-select-value">{selected?.label}</span>
        <svg className="wt-select-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2.5 4.5L6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            className="wt-select-menu"
            role="listbox"
            style={{
              top: rect.bottom + MENU_GAP,
              left: rect.left,
              width: rect.width,
              maxHeight: Math.min(MENU_MAX_HEIGHT, window.innerHeight - rect.bottom - 16)
            }}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`wt-select-option ${i === activeIndex ? 'wt-select-option-active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(o.value)}
              >
                <span className="wt-select-check">{o.value === value ? '✓' : ''}</span>
                <span className="wt-select-option-text">
                  <span className="wt-select-option-label">{o.label}</span>
                  {o.detail && <span className="wt-select-option-detail">{o.detail}</span>}
                </span>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
