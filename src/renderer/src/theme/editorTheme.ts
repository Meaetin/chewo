import { EditorView } from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import {
  deriveSurfaces,
  deriveTextRamp,
  withAlpha,
  type AppearanceSettings
} from '../../../shared/appearance'
import { MONO_STACK } from './terminalTheme'

// CodeMirror theme (files + notes) built from the user's appearance settings.
// Text + surfaces are derived from the base so the editor reads as one canvas
// with the terminal and tints with the base hue. Default syntax palette:
// brightened relatives of the app's accent set (periwinkle / Codex-blue /
// terracotta / amber / cyan), tuned for #181818.

export function makeEditorTheme(a: AppearanceSettings): Extension {
  const ramp = deriveSurfaces(a.base)
  const canvas = ramp.surfaces[1]
  const text = deriveTextRamp(a.base)
  const FG = text.primary
  const GUTTER_FG = text.tertiary
  const chrome = EditorView.theme(
    {
      '&': { backgroundColor: canvas, color: FG },
      '.cm-content': { fontFamily: MONO_STACK, caretColor: a.accent },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: a.accent },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: withAlpha(a.accent, 0.22) },
      '.cm-gutters': { backgroundColor: canvas, color: GUTTER_FG, border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      // Find panel chrome — the panel body itself is the React EditorFindPanel,
      // styled in styles.css; here we only replace CM's stock grey shell.
      '.cm-panels': { backgroundColor: ramp.surfaces[2], color: FG },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${ramp.line1}` },
      '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${ramp.line1}` },
      // Search matches — accent washes mirroring the transcript find highlights.
      '.cm-searchMatch': {
        backgroundColor: withAlpha(a.accent, 0.2),
        borderRadius: '2px',
        outline: `1px solid ${withAlpha(a.accent, 0.25)}`
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: withAlpha(a.accent, 0.45),
        outline: `1px solid ${a.accent}`
      },
      '.cm-selectionMatch': { backgroundColor: withAlpha(a.accent, 0.12) }
    },
    { dark: true }
  )

  const c = a.editor
  const highlightStyle = HighlightStyle.define(
    [
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: 'italic' },
      {
        tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.self],
        color: c.keyword
      },
      { tag: [t.string, t.special(t.string), t.docString], color: c.string },
      { tag: [t.number, t.integer, t.float], color: c.number },
      { tag: [t.bool, t.null, t.atom, t.unit], color: c.number },
      { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: c.function },
      { tag: [t.typeName, t.className, t.namespace, t.changed], color: c.type },
      { tag: t.variableName, color: FG },
      { tag: [t.propertyName, t.attributeValue], color: c.property },
      { tag: [t.tagName, t.angleBracket], color: c.tag },
      { tag: t.attributeName, color: c.attribute },
      { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: c.punctuation },
      { tag: [t.regexp, t.escape, t.special(t.string)], color: c.regexp },
      { tag: [t.meta, t.processingInstruction, t.documentMeta], color: GUTTER_FG },
      { tag: [t.link, t.url], color: c.link, textDecoration: 'underline' },
      { tag: t.heading, color: a.accent, fontWeight: 'bold' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strong, fontWeight: 'bold' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
      { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: c.number },
      { tag: t.invalid, color: c.invalid }
    ],
    { themeType: 'dark' }
  )

  return [chrome, syntaxHighlighting(highlightStyle)]
}
