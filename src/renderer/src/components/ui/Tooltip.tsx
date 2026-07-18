import { useEffect, useRef, useState } from 'react'

interface TooltipProps {
  label: React.ReactNode
  side?: 'top' | 'bottom'
  /** Hover-intent delay before showing (design/05 §3: ~450ms). Focus shows now. */
  delay?: number
  children: React.ReactNode
}

/**
 * Dependency-free tooltip: an absolutely-positioned bubble anchored to a
 * relative wrapper, so it never affects layout or forces overflow. Fade only.
 */
export function Tooltip({
  label,
  side = 'top',
  delay = 450,
  children
}: TooltipProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
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
  }

  useEffect(() => clear, [])

  return (
    <span
      className="tooltip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children}
      <span
        role="tooltip"
        className={`tooltip__bubble tooltip__bubble--${side}${
          visible ? ' tooltip__bubble--visible' : ''
        }`}
      >
        {label}
      </span>
    </span>
  )
}
