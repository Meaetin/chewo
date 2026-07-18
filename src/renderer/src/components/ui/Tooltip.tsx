import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  label: React.ReactNode
  side?: 'top' | 'bottom'
  /** Hover-intent delay before showing (design/05 §3: ~450ms). Focus shows now. */
  delay?: number
  children: React.ReactNode
}

/**
 * Tooltip whose bubble is portalled to <body> and positioned with fixed
 * coordinates, so no ancestor's `overflow: hidden` (sidebar, tab bar, window
 * edge) can ever clip it. Flips to the opposite side and clamps horizontally
 * when it would fall off-screen. Fade only; never affects layout.
 */
export function Tooltip({
  label,
  side = 'top',
  delay = 450,
  children
}: TooltipProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)

  const clear = (): void => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }
  const show = (): void => {
    clear()
    timer.current = window.setTimeout(() => setVisible(true), delay)
  }
  const showNow = (): void => {
    clear()
    setVisible(true)
  }
  const hide = (): void => {
    clear()
    setVisible(false)
    setPos(null)
  }

  // Measure trigger + bubble once shown, then place with flip + clamp.
  useLayoutEffect(() => {
    if (!visible) return
    const trigger = wrapRef.current?.getBoundingClientRect()
    const bubble = bubbleRef.current?.getBoundingClientRect()
    if (!trigger || !bubble) return
    const gap = 6
    const margin = 4
    let top = side === 'bottom' ? trigger.bottom + gap : trigger.top - bubble.height - gap
    if (top < margin) top = trigger.bottom + gap
    if (top + bubble.height > window.innerHeight - margin) {
      top = trigger.top - bubble.height - gap
    }
    let left = trigger.left + trigger.width / 2 - bubble.width / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - bubble.width - margin))
    setPos({ left, top })
    return clear
  }, [visible, side, label])

  return (
    <span
      ref={wrapRef}
      className="tooltip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children}
      {visible &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            className={`tooltip__bubble${pos ? ' tooltip__bubble--visible' : ''}`}
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          >
            {label}
          </span>,
          document.body
        )}
    </span>
  )
}
