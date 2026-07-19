import { useEffect, useRef } from 'react'
import { Terminal, type ILink, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { MONO_STACK } from '../theme/terminalTheme'

/**
 * Path-looking tokens in terminal output: absolute (`/…`), home (`~/…`),
 * dot-relative (`./…`, `../…`), relative with at least one slash
 * (`src/App.tsx`), or a bare filename with an extension (`package.json`) —
 * each optionally suffixed with `:line[:col]`. Only tokens that resolve to a
 * real file become links, so loose matches (URLs, `e.g.`) cost one stat and
 * stay plain text.
 */
const PATH_RE =
  /(?:(?:~|\.{1,2})?\/[\w.+@-]+(?:\/[\w.+@-]+)*|[\w.+@-]+(?:\/[\w.+@-]+)+|[\w+@-][\w.+@-]*\.[A-Za-z]\w{0,7})(?::\d+(?::\d+)?)?/g

interface TerminalPaneProps {
  termId: number
  active: boolean
  /** Root for resolving relative paths: worktree ?? project ?? home */
  root: string
  theme: ITheme
  onOpenFile: (path: string, goto?: { line: number; col?: number }) => void
}

export function TerminalPane({
  termId,
  active,
  root,
  theme,
  onOpenFile
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  // Ref so the create effect (keyed on termId) starts with the current theme
  const themeRef = useRef(theme)
  themeRef.current = theme
  // Refs so the link provider (registered once per terminal) sees current values
  const rootRef = useRef(root)
  rootRef.current = root
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: MONO_STACK,
      fontSize: 13,
      theme: themeRef.current
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

    // Clickable file paths — path-looking tokens that exist on disk open in
    // the editor layer. Relative paths resolve against the pane's root.
    const resolvePath = (raw: string): string => {
      const path = raw.replace(/:\d+(?::\d+)?$/, '')
      if (path.startsWith('/')) return path
      if (path.startsWith('~/')) return window.api.homeDir + path.slice(1)
      return `${rootRef.current}/${path.replace(/^\.\//, '')}`
    }
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1)
        if (!line) {
          callback(undefined)
          return
        }
        // Build the line text with a string-index → buffer-column map: wide
        // chars (CJK, emoji) occupy 2 cells and surrogate pairs are 2 string
        // chars, so plain translateToString indices drift from columns
        let text = ''
        const colOf: number[] = []
        for (let x = 0; x < line.length; ) {
          const cell = line.getCell(x)
          if (!cell) break
          const chars = cell.getChars() || ' '
          for (const ch of chars.split('')) {
            text += ch
            colOf.push(x)
          }
          x += cell.getWidth() || 1
        }
        const matches = [...text.matchAll(PATH_RE)]
        if (matches.length === 0) {
          callback(undefined)
          return
        }
        void Promise.all(
          matches.map(async (m): Promise<ILink | null> => {
            const target = resolvePath(m[0])
            if (!(await window.api.fsIsFile(target))) return null
            const suffix = /:(\d+)(?::(\d+))?$/.exec(m[0])
            const goto = suffix
              ? { line: Number(suffix[1]), col: suffix[2] ? Number(suffix[2]) : undefined }
              : undefined
            return {
              text: m[0],
              // 1-based, end-inclusive columns; the :line suffix stays clickable
              range: {
                start: { x: colOf[m.index] + 1, y },
                end: { x: colOf[m.index + m[0].length - 1] + 1, y }
              },
              activate: () => onOpenFileRef.current(target, goto)
            }
          })
        ).then((links) => {
          const found = links.filter((l) => l !== null)
          callback(found.length > 0 ? found : undefined)
        })
      }
    })

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

  // Live re-theme — xterm applies options.theme reassignment immediately
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme
  }, [theme])

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
