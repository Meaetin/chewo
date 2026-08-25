import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Dictation for one chat composer.
 *
 * The app already owns a whole speech pipeline — the Swift sidecar opens the
 * mic and main streams it to Deepgram (SPEC-NOTES §6) — so this adds no audio
 * code at all. What it adds is an address: main allows exactly one capture at
 * a time and now tags every event with the surface that asked for it, and this
 * hook drops anything that is not its own.
 *
 * Two panes could both be mounted and both listening, so ownership is checked
 * twice: main refuses a second capture outright, and `mine` below ignores
 * events that arrive for a capture this pane did not start. Without the second
 * check, every mounted composer would fill up with the words spoken into one
 * of them — panes are hidden with `display: none`, not unmounted.
 */
export type DictationPhase = 'idle' | 'connecting' | 'recording'

export interface Dictation {
  phase: DictationPhase
  /** 0–1 microphone level, for the pulse on the button */
  level: number
  /**
   * What has been heard so far — settled words plus the tail the model is
   * still revising. Shown in the composer while recording and replaced by the
   * final transcript when the stream closes.
   */
  live: string
  start: () => void
  stop: () => void
}

/**
 * @param onFinal receives the finished transcript; an empty one means nothing
 *   was heard, which is a normal outcome (a mis-click) rather than an error.
 * @param onError a ready-to-show sentence — no key, no sidecar, mic busy.
 */
export function useDictation(
  onFinal: (text: string) => void,
  onError?: (message: string) => void
): Dictation {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [level, setLevel] = useState(0)
  const [live, setLive] = useState('')

  // Refs, not state: the listener below is registered once and would
  // otherwise close over whatever these were when the pane mounted.
  const mine = useRef(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const settle = useCallback(() => {
    mine.current = false
    setPhase('idle')
    setLevel(0)
    setLive('')
  }, [])

  useEffect(() => {
    const off = window.api.onSttEvent((ev) => {
      // Another surface's dictation, or an ownerless recovery event
      if (ev.owner !== 'chat' || !mine.current) return
      switch (ev.event) {
        case 'ready':
          setPhase('recording')
          break
        case 'level':
          setLevel(ev.rms ?? 0)
          break
        case 'partial':
          setLive(`${ev.confirmed ?? ''}${ev.tail ?? ''}`)
          break
        case 'final':
          settle()
          onFinalRef.current(ev.text ?? '')
          break
        case 'error':
          // Includes the refusals main answers `stt:start` with — a missing
          // key, an unbuilt sidecar, a mic another surface already holds.
          settle()
          onErrorRef.current?.(ev.message ?? 'Dictation failed.')
          break
      }
    })
    return () => {
      off()
    }
  }, [settle])

  const start = useCallback(() => {
    if (phaseRef.current !== 'idle') return
    mine.current = true
    setLive('')
    setPhase('connecting')
    window.api.sttStartChat()
  }, [])

  const stop = useCallback(() => {
    if (phaseRef.current === 'idle') return
    // Not an unwind: the sidecar drains its queue and main closes the stream,
    // so the words already spoken still come back as `final`.
    window.api.sttStop()
  }, [])

  // A pane that goes away mid-sentence must not leave the mic open for a
  // session nobody is looking at.
  useEffect(
    () => () => {
      if (mine.current) window.api.sttStop()
    },
    []
  )

  return { phase, level, live, start, stop }
}
