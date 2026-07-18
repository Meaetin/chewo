import { useCallback, useEffect, useRef, useState } from 'react'

interface ImageStageProps {
  src: string
  alt: string
  /** Editor layer is actually on screen — only then do we claim Space globally */
  active: boolean
}

interface Transform {
  /** Zoom factor */
  scale: number
  /** Pan offset from the centered layout position, in screen px */
  tx: number
  ty: number
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 }
const MIN_SCALE = 0.1
const MAX_SCALE = 20

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/**
 * Zoom/pan viewport for images and rendered SVGs. Pinch or ctrl+wheel zooms
 * toward the cursor; plain wheel (two-finger drag) pans; Space + left-drag
 * pans with a grab cursor; double-click resets to fit.
 */
export function ImageStage({ src, alt, active }: ImageStageProps): React.JSX.Element {
  const stage = useRef<HTMLDivElement | null>(null)
  const [t, setT] = useState<Transform>(IDENTITY)
  const [spaceDown, setSpaceDown] = useState(false)
  const panning = useRef<{ x: number; y: number } | null>(null)

  // Reset when the source changes (switching between open images)
  useEffect(() => setT(IDENTITY), [src])

  // Wheel: ctrl/pinch zooms toward the cursor, otherwise pan. Non-passive so
  // we can suppress the browser's own page zoom/scroll.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      // Cursor position relative to the container centre (transform-origin)
      const px = e.clientX - rect.left - rect.width / 2
      const py = e.clientY - rect.top - rect.height / 2
      setT((prev) => {
        if (e.ctrlKey) {
          const next = clampScale(prev.scale * Math.exp(-e.deltaY / 100))
          const k = next / prev.scale
          // Keep the content point under the cursor fixed
          return { scale: next, tx: px - k * (px - prev.tx), ty: py - k * (py - prev.ty) }
        }
        return { ...prev, tx: prev.tx - e.deltaX, ty: prev.ty - e.deltaY }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Space toggles pan mode; suppress its page-scroll while the stage is shown.
  // Only claim Space when the editor layer is actually on screen — otherwise a
  // hidden image buffer would eat spacebar in the terminal.
  useEffect(() => {
    if (!active) {
      setSpaceDown(false)
      return
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        e.preventDefault()
        setSpaceDown(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [active])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!spaceDown || e.button !== 0) return
      e.preventDefault()
      panning.current = { x: e.clientX, y: e.clientY }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [spaceDown]
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = panning.current
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    panning.current = { x: e.clientX, y: e.clientY }
    setT((prev) => ({ ...prev, tx: prev.tx + dx, ty: prev.ty + dy }))
  }, [])

  const endPan = useCallback((e: React.PointerEvent) => {
    if (panning.current) {
      panning.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const cursor = spaceDown ? (panning.current ? 'grabbing' : 'grab') : 'default'

  return (
    <div
      ref={stage}
      className="file-editor-image-stage"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={() => setT(IDENTITY)}
    >
      <img
        className="file-editor-image"
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})` }}
      />
      <div className="file-editor-image-hint">
        {Math.round(t.scale * 100)}% · pinch to zoom · space-drag to pan · double-click to reset
      </div>
    </div>
  )
}
