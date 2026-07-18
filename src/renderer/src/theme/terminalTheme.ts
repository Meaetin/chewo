import type { ITheme } from '@xterm/xterm'
import { CANVAS_BG } from '../../../shared/colors'

// xterm mono stack — mirrors --font-mono in styles.css (JS can't read the CSS var).
export const MONO_STACK = "'Berkeley Mono', 'SF Mono', ui-monospace, Menlo, monospace"

// Kiln/Graphite ANSI-16 (design/06). Values mirror styles.css primitives where a
// token exists; ANSI green is deliberately a distinct yellow-green so it never blurs
// into the emerald cursor.
export const TERMINAL_THEME: ITheme = {
  background: CANVAS_BG, // --c-surface-1
  foreground: '#e9e7e4', // --c-text-primary
  cursor: '#3bbf8b', // --c-accent (emerald)
  cursorAccent: CANVAS_BG,
  selectionBackground: 'rgba(59, 191, 139, 0.25)', // emerald 25%

  black: '#232323',
  brightBlack: '#5a5a5a',
  red: '#e2574b', // --c-danger
  brightRed: '#ec6c61',
  green: '#79b36a', // distinct from the emerald cursor
  brightGreen: '#93c586',
  yellow: '#dfa94e', // --c-warning
  brightYellow: '#e9bc6e',
  blue: '#6ba4f8', // Codex vivid
  brightBlue: '#8fbdfa',
  magenta: '#c98aa9',
  brightMagenta: '#d6a2bc',
  cyan: '#34c9d6', // --c-live
  brightCyan: '#5fd7e2',
  white: '#d8d5d0',
  brightWhite: '#f4f1ec'
}
