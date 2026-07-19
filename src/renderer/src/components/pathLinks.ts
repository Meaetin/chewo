import {
  Decoration,
  EditorView,
  StateEffect,
  StateField,
  type Extension
} from '@uiw/react-codemirror'

/**
 * ⌘-click file navigation inside the editor: path-looking tokens (import
 * specifiers, `src/foo.ts:12` references, …) underline on ⌘-hover once they
 * resolve to a real file, and ⌘-click opens them. Relative specifiers resolve
 * against the shown file's directory first, then the section root, trying the
 * usual extensionless-import candidates (`.ts`, `.tsx`, …, `/index.*`).
 */

interface Token {
  text: string
  from: number
  to: number
}

const TOKEN_CHAR = /[\w.+@/~-]/
const GOTO_SUFFIX = /:(\d+)(?::(\d+))?$/

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.md']
const INDEX_EXTS = ['.ts', '.tsx', '.js']

function tokenAt(view: EditorView, pos: number): Token | null {
  const line = view.state.doc.lineAt(pos)
  const s = line.text
  const i = pos - line.from
  if (i >= s.length || !TOKEN_CHAR.test(s[i])) return null
  let from = i
  while (from > 0 && TOKEN_CHAR.test(s[from - 1])) from--
  let to = i + 1
  while (to < s.length && TOKEN_CHAR.test(s[to])) to++
  // absorb a trailing :line[:col]
  const suffix = /^:\d+(?::\d+)?/.exec(s.slice(to))
  if (suffix) to += suffix[0].length
  return { text: s.slice(from, to), from: line.from + from, to: line.from + to }
}

/** Cheap pre-filter before hitting the filesystem */
function looksLikePath(text: string): boolean {
  const base = text.replace(GOTO_SUFFIX, '')
  if (!/[A-Za-z]/.test(base)) return false
  return base.includes('/') || /\.[A-Za-z]\w{0,7}$/.test(base)
}

const sameToken = (a: Token | null, b: Token | null): boolean =>
  a !== null && b !== null && a.from === b.from && a.to === b.to

export interface PathLinksConfig {
  /** Absolute path of the displayed file — anchors relative specifiers */
  filePath: string
  /** Section root — fallback base for bare relative paths */
  root: string
  onOpen: (path: string, goto?: { line: number; col?: number }) => void
}

export function pathLinks(cfg: PathLinksConfig): Extension {
  const dir = cfg.filePath.split('/').slice(0, -1).join('/')
  const home = window.api.homeDir

  const candidates = (spec: string): string[] => {
    const bases = spec.startsWith('/')
      ? [spec]
      : spec.startsWith('~/')
        ? [home + spec.slice(1)]
        : spec.startsWith('.')
          ? [`${dir}/${spec}`]
          : [`${dir}/${spec}`, `${cfg.root}/${spec}`]
    return bases.flatMap((b) => [
      b,
      ...EXTS.map((e) => b + e),
      ...INDEX_EXTS.map((e) => `${b}/index${e}`)
    ])
  }

  // token text → resolved absolute path (or null); lives as long as the
  // extension instance, i.e. per shown file
  const resolved = new Map<string, Promise<string | null>>()
  const resolveToken = (text: string): Promise<string | null> => {
    let p = resolved.get(text)
    if (!p) {
      p = (async () => {
        for (const cand of candidates(text.replace(GOTO_SUFFIX, ''))) {
          if (await window.api.fsIsFile(cand)) return cand
        }
        return null
      })()
      resolved.set(text, p)
    }
    return p
  }

  const setLink = StateEffect.define<Token | null>()
  const linkMark = Decoration.mark({ class: 'cm-path-link' })
  const linkField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      for (const e of tr.effects) {
        if (e.is(setLink))
          return e.value
            ? Decoration.set([linkMark.range(e.value.from, e.value.to)])
            : Decoration.none
      }
      return deco.map(tr.changes)
    },
    provide: (f) => EditorView.decorations.from(f)
  })

  /** The token currently underlined */
  let hovered: Token | null = null
  /** The token under the mouse right now — late resolutions check against it */
  let lastTok: Token | null = null

  const clear = (view: EditorView): void => {
    lastTok = null
    if (hovered) {
      hovered = null
      view.dispatch({ effects: setLink.of(null) })
    }
  }

  const handlers = EditorView.domEventHandlers({
    mousemove: (e, view) => {
      if (!e.metaKey) {
        clear(view)
        return false
      }
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      const tok = pos === null ? null : tokenAt(view, pos)
      if (!tok || !looksLikePath(tok.text)) {
        clear(view)
        return false
      }
      if (sameToken(tok, lastTok)) return false
      lastTok = tok
      void resolveToken(tok.text).then((path) => {
        if (!sameToken(tok, lastTok)) return // mouse moved on
        if (path && !sameToken(tok, hovered)) {
          hovered = tok
          view.dispatch({ effects: setLink.of(tok) })
        } else if (!path && hovered) {
          hovered = null
          view.dispatch({ effects: setLink.of(null) })
        }
      })
      return false
    },
    mouseleave: (_e, view) => {
      clear(view)
      return false
    },
    keyup: (e, view) => {
      if (e.key === 'Meta') clear(view)
      return false
    },
    blur: (_e, view) => {
      clear(view)
      return false
    },
    mousedown: (e, view) => {
      if (!e.metaKey || e.button !== 0) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      const tok = pos === null ? null : tokenAt(view, pos)
      if (!tok || !looksLikePath(tok.text)) return false
      void resolveToken(tok.text).then((path) => {
        if (!path) return
        const suffix = GOTO_SUFFIX.exec(tok.text)
        cfg.onOpen(
          path,
          suffix
            ? { line: Number(suffix[1]), col: suffix[2] ? Number(suffix[2]) : undefined }
            : undefined
        )
      })
      return true // claim the click — no cursor jump under a followed link
    }
  })

  const theme = EditorView.baseTheme({
    '.cm-path-link': { textDecoration: 'underline', cursor: 'pointer' }
  })

  return [linkField, handlers, theme]
}
