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
import type { TopicRef } from './NotesSidebar'

const AUTOSAVE_MS = 800

/** App-wide dictation state — one recording at a time, owned by App. */
export type RecordingState =
  | { phase: 'loading'; ref: TopicRef }
  | {
      phase: 'recording'
      ref: TopicRef
      confirmed: string
      tail: string
      level: number
      startedAt: number
    }
  | { phase: 'structuring'; ref: TopicRef }

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

function formatElapsed(startedAt: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** Live dictation view: level meter, elapsed, confirmed text solid + in-flight tail dimmed. */
function RecordingPanel({
  rec,
  onStop
}: {
  rec: RecordingState
  onStop: () => void
}): React.JSX.Element {
  const [, forceTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  return (
    <div className="recording-panel">
      <div className="recording-status-row">
        {rec.phase === 'loading' && (
          <span className="recording-status">
            Loading Whisper model… first run downloads it (~630 MB), later runs are instant.
          </span>
        )}
        {rec.phase === 'recording' && (
          <>
            <span className="recording-dot">●</span>
            <span className="recording-elapsed">{formatElapsed(rec.startedAt)}</span>
            <div className="level-meter">
              <div
                className="level-meter-fill"
                style={{ width: `${Math.min(100, Math.round(rec.level * 100))}%` }}
              />
            </div>
            <button className="recording-stop-button" onClick={onStop}>
              ■ Stop
            </button>
          </>
        )}
        {rec.phase === 'structuring' && (
          <span className="recording-status">Structuring the transcript with Claude…</span>
        )}
      </div>

      {rec.phase !== 'loading' && (
        <div className="recording-transcript" ref={scrollRef}>
          {rec.phase === 'recording' && !rec.confirmed && !rec.tail ? (
            <span className="transcript-tail">Listening…</span>
          ) : (
            <>
              {rec.phase === 'recording' && (
                <>
                  <span>{rec.confirmed}</span>{' '}
                  <span className="transcript-tail">{rec.tail}</span>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface NotesWorkspaceProps {
  subject: string
  topic: NotesTopic
  selectedNotePath: string | null
  recording: RecordingState | null
  onStartRecording: () => void
  onStopRecording: () => void
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
  recording,
  onStartRecording,
  onStopRecording,
  onSelectNote,
  onCreateNote,
  onDeleteNote
}: NotesWorkspaceProps): React.JSX.Element {
  const recordingHere =
    recording && recording.ref.subject === subject && recording.ref.topic === topic.name
      ? recording
      : null
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
            title={
              recording
                ? 'A recording is already in progress'
                : 'Record a lesson — live transcript, structured note on stop'
            }
            disabled={!!recording}
            onClick={onStartRecording}
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
        {recordingHere ? (
          <RecordingPanel rec={recordingHere} onStop={onStopRecording} />
        ) : selectedNotePath ? (
          <NoteEditor key={selectedNotePath} path={selectedNotePath} />
        ) : (
          <div className="empty-state">
            <h2>
              {subject} / {topic.name}
            </h2>
            <p>Select a note on the left, create one with “+”, or hit ● to dictate a lesson.</p>
          </div>
        )}
      </div>
    </div>
  )
}
