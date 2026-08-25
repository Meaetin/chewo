import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'

interface ResizablePaneProps {
  className: string
  size: number
  min: number
  max: number
  onSizeChange: (size: number) => void
  children: ReactNode
  style?: CSSProperties
}

/** Horizontal pane whose right-edge separator owns pointer and keyboard resizing. */
export function ResizablePane({
  className,
  size,
  min,
  max,
  onSizeChange,
  children,
  style
}: ResizablePaneProps): React.JSX.Element {
  const drag = useRef<{ x: number; size: number } | null>(null)
  const clamp = (value: number): number => Math.min(Math.max(Math.round(value), min), max)

  useEffect(
    () => () => {
      document.body.classList.remove('pane-resizing')
    },
    []
  )

  return (
    <div className={className} style={{ ...style, width: size, minWidth: size }}>
      {children}
      <div
        className="pane-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={size}
        tabIndex={0}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, size }
          event.currentTarget.setPointerCapture(event.pointerId)
          document.body.classList.add('pane-resizing')
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          onSizeChange(clamp(drag.current.size + event.clientX - drag.current.x))
        }}
        onPointerUp={(event) => {
          drag.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          document.body.classList.remove('pane-resizing')
        }}
        onPointerCancel={() => {
          drag.current = null
          document.body.classList.remove('pane-resizing')
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const step = event.shiftKey ? 32 : 8
          onSizeChange(clamp(size + (event.key === 'ArrowRight' ? step : -step)))
        }}
      />
    </div>
  )
}
