import { EditorView } from '@uiw/react-codemirror'
import { CANVAS_BG } from '../../../shared/colors'
import { MONO_STACK } from './terminalTheme'

// Graphite CodeMirror theme for the notes editor. Colours mirror the styles.css
// primitives (JS can't read CSS vars); the canvas shares --c-surface-1 with the
// terminal so both content surfaces read as one.
const FG = '#e9e7e4' // --c-text-primary
const ACCENT = '#3bbf8b' // --c-accent (emerald)
const SELECTION = 'rgba(59, 191, 139, 0.22)' // emerald wash
const GUTTER_FG = '#807d78' // --c-text-tertiary

export const editorTheme = EditorView.theme(
  {
    '&': { backgroundColor: CANVAS_BG, color: FG },
    '.cm-content': { fontFamily: MONO_STACK, caretColor: ACCENT },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: ACCENT },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: SELECTION },
    '.cm-gutters': { backgroundColor: CANVAS_BG, color: GUTTER_FG, border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' }
  },
  { dark: true }
)
