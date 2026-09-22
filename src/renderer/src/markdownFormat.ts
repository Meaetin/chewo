import { EditorSelection, type ChangeSpec, type Line, type StateCommand } from '@codemirror/state'

/**
 * Markdown formatting commands behind the lesson editor's toolbar.
 *
 * CodeMirror ships no markdown formatting commands — `@codemirror/lang-markdown`
 * only parses and highlights — so the toolbar edits the text itself. Everything
 * here is a `StateCommand`, which is a pure function of the editor state, so
 * these are unit-testable without mounting an editor.
 *
 * Every command toggles: running it on text that already carries the mark
 * takes the mark off again, which is what a pressed toolbar button implies.
 */

const HEADING = /^(#{1,6})\s+/
const USER_EVENT = 'input.format'

/** The lines the main selection touches — a bare cursor touches exactly one. */
function selectedLines(state: Parameters<StateCommand>[0]['state']): Line[] {
  const { from, to } = state.selection.main
  const lines: Line[] = []
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos)
    lines.push(line)
    if (line.to >= state.doc.length) break
    pos = line.to + 1
  }
  return lines
}

/**
 * Wraps the selection in `mark` — `**` for bold, `*` for italic, `` ` `` for
 * code. With nothing selected it inserts an empty pair and parks the cursor
 * inside, so the button can be pressed before the word is typed.
 *
 * Unwrapping accepts both shapes a user can produce: markers sitting just
 * outside the selection (double-click a bold word and the selection covers the
 * word, not the asterisks) and markers inside it (drag across the whole thing).
 */
export const toggleInline =
  (mark: string): StateCommand =>
  ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      const outside =
        state.sliceDoc(range.from - mark.length, range.from) === mark &&
        state.sliceDoc(range.to, range.to + mark.length) === mark
      if (outside) {
        return {
          changes: [
            { from: range.from - mark.length, to: range.from },
            { from: range.to, to: range.to + mark.length }
          ],
          range: EditorSelection.range(range.from - mark.length, range.to - mark.length)
        }
      }
      const text = state.sliceDoc(range.from, range.to)
      const inside =
        text.length >= mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)
      if (inside) {
        return {
          changes: [
            { from: range.from, to: range.from + mark.length },
            { from: range.to - mark.length, to: range.to }
          ],
          range: EditorSelection.range(range.from, range.to - mark.length * 2)
        }
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark }
        ],
        range: EditorSelection.range(range.from + mark.length, range.to + mark.length)
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: USER_EVENT }))
    return true
  }

/**
 * Turns the touched lines into level-`n` headings, or back into body text if
 * they are already at that level. A heading at a different level is replaced
 * rather than stacked, so ⟨H2⟩ on an `# Title` gives `## Title`.
 */
export const toggleHeading =
  (level: number): StateCommand =>
  ({ state, dispatch }) => {
    const hashes = '#'.repeat(level) + ' '
    const lines = selectedLines(state)
    const allAtLevel = lines.every((l) => l.text.match(HEADING)?.[1].length === level)
    const changes: ChangeSpec[] = []
    for (const line of lines) {
      const existing = line.text.match(HEADING)
      const to = line.from + (existing ? existing[0].length : 0)
      changes.push({ from: line.from, to, insert: allAtLevel ? '' : hashes })
    }
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: USER_EVENT }))
    return true
  }

/**
 * Toggles a line prefix — `- ` for bullets, `> ` for quotes. Blank lines in a
 * multi-line selection are left alone: a bullet with nothing on it is noise,
 * not something anyone dragged across three paragraphs to get. A cursor
 * resting on a blank line is the exception, since that is a deliberate ask.
 *
 * A selection where only some lines carry the prefix gains it on the rest,
 * rather than toggling off — otherwise half a list would silently unbullet.
 */
export const toggleLinePrefix =
  (prefix: string): StateCommand =>
  ({ state, dispatch }) => {
    const touched = selectedLines(state)
    const lines = touched.some((l) => l.text.trim()) ? touched.filter((l) => l.text.trim()) : touched
    const indentOf = (l: Line): number => l.text.length - l.text.trimStart().length
    const has = (l: Line): boolean => l.text.trimStart().startsWith(prefix)
    const allHave = lines.every(has)
    const changes: ChangeSpec[] = []
    for (const line of lines) {
      const at = line.from + indentOf(line)
      if (allHave) changes.push({ from: at, to: at + prefix.length })
      else if (!has(line)) changes.push({ from: at, insert: prefix })
    }
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: USER_EVENT }))
    return true
  }

const LINK_PLACEHOLDER = 'url'

/**
 * Wraps the selection as `[text](url)` and selects `url`, so the address can be
 * pasted straight over it. With nothing selected the cursor lands in the label
 * instead — there is no text to link yet.
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    const insert = `[${text}](${LINK_PLACEHOLDER})`
    const urlAt = range.from + text.length + 3
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text
        ? EditorSelection.range(urlAt, urlAt + LINK_PLACEHOLDER.length)
        : EditorSelection.cursor(range.from + 1)
    }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: USER_EVENT }))
  return true
}

/** Display maths on its own line — the shape KaTeX renders centred. */
export const insertMathBlock: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    const line = state.doc.lineAt(range.from)
    const lead = line.from === range.from ? '' : '\n'
    const insert = `${lead}$$\n${text}\n$$\n`
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + lead.length + 3 + text.length)
    }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: USER_EVENT }))
  return true
}
