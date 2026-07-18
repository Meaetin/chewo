import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import {
  parseNote,
  serializeNote,
  type NoteFrontmatter,
  type NoteSource,
  type NotesTopic
} from '../../../shared/notes'

const AUTOSAVE_MS = 800

function noteDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

/**
 * Markdown editor for one note file. Owns its load/save cycle — parent keys
 * this by path so switching notes remounts with fresh state. Title edits
 * rewrite the frontmatter; the filename stays put.
 */
function NoteEditor({ path }: { path: string }): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(false)
  const meta = useRef<Omit<NoteFrontmatter, 'title'>>({
    date: new Date().toISOString(),
    source: 'typed',
    status: 'structured'
  })
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.notesRead(path).then((content) => {
      if (!alive) return
      const parsed = parseNote(content)
      setTitle(parsed.title ?? '')
      setBody(parsed.body)
      meta.current = {
        date: parsed.date ?? new Date().toISOString(),
        source: parsed.source ?? 'typed',
        status: parsed.status ?? 'structured'
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [path])

  const save = useCallback(() => {
    if (!dirty.current) return
    dirty.current = false
    void window.api.notesWrite(
      path,
      serializeNote({ title: title.trim() || 'Untitled', ...meta.current }, body)
    )
  }, [path, title, body])

  // Debounced autosave; also flush on unmount (note switch, workflow switch)
  useEffect(() => {
    if (!loaded || !dirty.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(save, AUTOSAVE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [loaded, title, body, save])
  useEffect(() => save, [save])

  if (!loaded) return <div className="notes-editor-loading">Loading…</div>

  return (
    <>
      <div className="notes-editor-header">
        <input
          className="notes-title-input"
          placeholder="Untitled"
          value={title}
          onChange={(e) => {
            dirty.current = true
            setTitle(e.target.value)
          }}
        />
        <button
          className={`notes-mode-button ${!preview ? 'notes-mode-button-active' : ''}`}
          onClick={() => setPreview(false)}
        >
          Edit
        </button>
        <button
          className={`notes-mode-button ${preview ? 'notes-mode-button-active' : ''}`}
          onClick={() => setPreview(true)}
        >
          Preview
        </button>
      </div>
      <div className="notes-editor-body">
        {preview ? (
          <div className="notes-md-preview message-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || '*Empty note*'}</ReactMarkdown>
          </div>
        ) : (
          <CodeMirror
            className="notes-editor-cm"
            value={body}
            theme="dark"
            height="100%"
            extensions={[markdown()]}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false
            }}
            onChange={(value) => {
              dirty.current = true
              setBody(value)
            }}
          />
        )}
      </div>
    </>
  )
}

interface NotesWorkspaceProps {
  subject: string
  topic: NotesTopic
  selectedNotePath: string | null
  onSelectNote: (path: string | null) => void
  onCreateNote: (title: string, body?: string, source?: NoteSource) => Promise<void>
  onDeleteNote: (path: string) => void
}

/**
 * The sub-level workspace (OneNote section view): page list on the left,
 * editor on the right. The dictation/record button lands in this header in
 * phase N2 (SPEC-NOTES.md §8).
 */
export function NotesWorkspace({
  subject,
  topic,
  selectedNotePath,
  onSelectNote,
  onCreateNote,
  onDeleteNote
}: NotesWorkspaceProps): React.JSX.Element {
  const pasteNote = async (): Promise<void> => {
    const text = (await navigator.clipboard.readText()).trim()
    if (!text) return
    const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60)
    await onCreateNote(firstLine || 'Pasted note', text, 'paste')
  }

  return (
    <div className="notes-workspace">
      <div className="notes-pages">
        <div className="notes-pages-header">
          <span className="notes-pages-title" title={`${subject} / ${topic.name}`}>
            {topic.name}
          </span>
          <button
            className="notes-record-button"
            title="Record a lesson — dictation arrives in phase N2"
            disabled
          >
            ●
          </button>
          <button
            className="project-add-button"
            title="Paste clipboard as a new note"
            onClick={() => void pasteNote()}
          >
            ⎘
          </button>
          <button
            className="project-add-button"
            title="New note"
            onClick={() => void onCreateNote('Untitled')}
          >
            +
          </button>
        </div>

        <div className="notes-pages-list">
          {topic.notes.map((n) => (
            <div
              key={n.path}
              className={`note-page-row ${n.path === selectedNotePath ? 'note-page-row-selected' : ''}`}
              onClick={() => onSelectNote(n.path)}
            >
              <div className="note-page-top">
                <span className="note-page-title">{n.title}</span>
                <button
                  className="session-action-button"
                  title="Move note to Trash"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteNote(n.path)
                  }}
                >
                  ✕
                </button>
              </div>
              <div className="note-page-date">
                {noteDate(n.date)}
                {n.source !== 'typed' && ` · ${n.source}`}
              </div>
            </div>
          ))}
          {topic.notes.length === 0 && (
            <div className="session-list-empty">
              No notes in this topic yet — “+” to write one, “⎘” to paste one.
            </div>
          )}
        </div>
      </div>

      <div className="notes-editor">
        {selectedNotePath ? (
          <NoteEditor key={selectedNotePath} path={selectedNotePath} />
        ) : (
          <div className="empty-state">
            <h2>
              {subject} / {topic.name}
            </h2>
            <p>Select a note on the left, or create one with “+”.</p>
          </div>
        )}
      </div>
    </div>
  )
}
