import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalPaneProps {
  termId: number
  active: boolean
}

export function TerminalPane({ termId, active }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: 'SF Mono, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#16161e' }
    })

    // ⌘+/⌘−/⌘0 zoom this pane's font (menu zoom roles are removed app-wide)
    const DEFAULT_FONT_SIZE = 13
    const setFontSize = (size: number): void => {
      term.options.fontSize = Math.min(28, Math.max(8, size))
      doFit()
    }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.metaKey || e.ctrlKey)) return true
      if (e.key === '=' || e.key === '+') {
        setFontSize((term.options.fontSize ?? DEFAULT_FONT_SIZE) + 1)
        return false
      }
      if (e.key === '-') {
        setFontSize((term.options.fontSize ?? DEFAULT_FONT_SIZE) - 1)
        return false
      }
      if (e.key === '0') {
        setFontSize(DEFAULT_FONT_SIZE)
        return false
      }
      return true
    })
    const fit = new FitAddon()
    fitRef.current = fit
    termRef.current = term
    term.loadAddon(fit)
    term.open(container)
    term.focus() // type immediately — no click required

    term.onData((data) => window.api.termInput(termId, data))

    const offData = window.api.onTermData(({ id, data }) => {
      if (id === termId) term.write(data)
    })
    const offExit = window.api.onTermExit(({ id, exitCode }) => {
      if (id === termId) term.write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`)
    })

    const doFit = (): void => {
      // Fitting while hidden yields 0×0 — only fit when the pane has real size
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fit.fit()
        window.api.termResize(termId, term.cols, term.rows)
      }
    }
    const resizeObserver = new ResizeObserver(doFit)
    resizeObserver.observe(container)
    doFit()

    return () => {
      resizeObserver.disconnect()
      offData()
      offExit()
      termRef.current = null
      term.dispose()
    }
  }, [termId])

  useEffect(() => {
    if (active) {
      // Re-fit and take keyboard focus after becoming visible
      // (display:none while inactive)
      requestAnimationFrame(() => {
        const container = containerRef.current
        if (container && container.offsetWidth > 0) fitRef.current?.fit()
        termRef.current?.focus()
      })
    }
  }, [active])

  return (
    <div
      ref={containerRef}
      className="terminal-pane"
      style={{ display: active ? 'block' : 'none' }}
    />
  )
}
