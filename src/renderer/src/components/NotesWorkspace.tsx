import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { ClipboardPaste, Mic, Plus, Sparkles, Square, X } from 'lucide-react'
import { Button, IconButton, Row, WorkingText } from './ui'
import {
  parseNote,
  serializeNote,
  type NoteFrontmatter,
  type NoteSource,
  type NotesTopic
} from '../../../shared/notes'
import type { TopicRef } from './NotesSidebar'

const AUTOSAVE_MS = 800

/** App-wide dictation state — one recording at a time, owned by App. A
 * recording is bound to the lesson it was started on and appends into it. */
export type RecordingState =
  | { phase: 'loading'; ref: TopicRef; notePath: string }
  | {
      phase: 'recording'
      ref: TopicRef
      notePath: string
      confirmed: string
      tail: string
      level: number
      startedAt: number
    }
  | { phase: 'structuring'; ref: TopicRef; notePath: string }

/** Structured dictation output waiting to be appended into an open editor. */
export interface PendingAppend {
  id: number
  path: string
  text: string
}

function noteDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

/**
 * Markdown editor for one lesson file. Owns its load/save cycle — parent keys
 * this by path so switching lessons remounts with fresh state. Title edits
 * rewrite the frontmatter; the filename stays put. Dictation results arrive
 * as `pendingAppend` and are folded into the editor state (never a raw file
 * write), so typing during a recording is never clobbered.
 */
function NoteEditor({
  path,
  pendingAppend,
  onAppendApplied
}: {
  path: string
  pendingAppend: PendingAppend | null
  onAppendApplied: (id: number) => void
}): React.JSX.Element {
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

  useEffect(() => {
    if (!loaded || !pendingAppend || pendingAppend.path !== path) return
    dirty.current = true
    setBody((b) => (b.trim() ? b.replace(/\s+$/, '') + '\n\n' : '') + pendingAppend.text + '\n')
    onAppendApplied(pendingAppend.id)
  }, [loaded, pendingAppend, path, onAppendApplied])

  const save = useCallback(() => {
    if (!dirty.current) return
    dirty.current = false
    void window.api.notesWrite(
      path,
      serializeNote({ title: title.trim() || 'Untitled', ...meta.current }, body)
    )
  }, [path, title, body])

  // Debounced autosave; also flush on unmount (lesson switch, workflow switch)
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
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || '*Empty lesson*'}</ReactMarkdown>
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

function RecordingClock({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [, forceTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return (
    <span className="recording-elapsed">
      {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
    </span>
  )
}

/** Live transcript tab: level meter + confirmed text solid, in-flight tail dimmed. */
function RecordingPanel({ rec }: { rec: RecordingState }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  if (rec.phase === 'loading') {
    return (
      <div className="recording-panel">
        <div className="recording-status-row">
          <span className="recording-status">
            Loading Whisper model… first run downloads it (~630 MB), later runs are instant.
          </span>
        </div>
      </div>
    )
  }

  if (rec.phase === 'structuring') {
    return (
      <div className="recording-panel">
        <div className="recording-status-row">
          <span className="recording-status">
            Structuring the dictation with Claude — it will append to this lesson…
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="recording-panel">
      <div className="recording-status-row">
        <div className="level-meter">
          <div
            className="level-meter-fill"
            style={{ width: `${Math.min(100, Math.round(rec.level * 100))}%` }}
          />
        </div>
      </div>
      <div className="recording-transcript" ref={scrollRef}>
        {!rec.confirmed && !rec.tail ? (
          <span className="transcript-tail">Listening…</span>
        ) : (
          <>
            <span>{rec.confirmed}</span> <span className="transcript-tail">{rec.tail}</span>
          </>
        )}
      </div>
    </div>
  )
}

interface NotesWorkspaceProps {
  subject: string
  topic: NotesTopic
  selectedNotePath: string | null
  recording: RecordingState | null
  pendingAppend: PendingAppend | null
  onAppendApplied: (id: number) => void
  onToggleChat: () => void
  onStartRecording: () => void
  onStopRecording: () => void
  onSelectNote: (path: string | null) => void
  onCreateNote: (title: string, body?: string, source?: NoteSource) => Promise<void>
  onDeleteNote: (path: string) => void
}

/**
 * The topic workspace (OneNote section view): lesson list on the left, the
 * lesson pane on the right. While recording, the pane splits into
 * Note | Live transcript tabs so you can type into the lesson while the
 * lecture streams in; the dictation appends to the lesson on stop.
 */
export function NotesWorkspace({
  subject,
  topic,
  selectedNotePath,
  recording,
  pendingAppend,
  onAppendApplied,
  onToggleChat,
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

  const [recTab, setRecTab] = useState<'note' | 'transcript'>('note')
  const wasRecording = useRef(false)
  useEffect(() => {
    if (recordingHere && !wasRecording.current) setRecTab('transcript')
    wasRecording.current = !!recordingHere
  }, [recordingHere])

  const pasteNote = async (): Promise<void> => {
    const text = (await navigator.clipboard.readText()).trim()
    if (!text) return
    const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60)
    await onCreateNote(firstLine || 'Pasted lesson', text, 'paste')
  }

  const showEditorStack = !recordingHere || recTab === 'note'

  return (
    <div className="notes-workspace">
      <div className="notes-pages">
        <div className="notes-pages-header">
          <span className="notes-pages-title" title={`${subject} / ${topic.name}`}>
            {topic.name}
          </span>
          <IconButton
            label="Paste clipboard as a new lesson"
            dense
            onClick={() => void pasteNote()}
          >
            <ClipboardPaste />
          </IconButton>
          <IconButton label="New lesson" dense onClick={() => void onCreateNote('Untitled')}>
            <Plus />
          </IconButton>
        </div>

        <div className="notes-pages-list">
          {topic.notes.map((n) => (
            <Row
              key={n.path}
              selected={n.path === selectedNotePath}
              onClick={() => onSelectNote(n.path)}
              className="note-page-item"
              trailing={
                <IconButton
                  label="Move lesson to Trash"
                  dense
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteNote(n.path)
                  }}
                >
                  <X />
                </IconButton>
              }
            >
              <span className="note-page-body">
                <span className="note-page-title">{n.title}</span>
                <span className="note-page-date">
                  {noteDate(n.date)}
                  {n.source !== 'typed' && ` · ${n.source}`}
                </span>
              </span>
            </Row>
          ))}
          {topic.notes.length === 0 && (
            <div className="session-list-empty">
              No lessons in this topic yet — add one with the New lesson button, or paste one
              from the clipboard.
            </div>
          )}
        </div>
      </div>

      <div className="notes-editor">
        {/* Recording is bound to the selected lesson and appends into it —
            reachable only once subject, topic and lesson are chosen */}
        <div className="notes-workspace-bar">
          <span className="notes-breadcrumb" title={topic.path}>
            {subject} / {topic.name}
          </span>

          {recordingHere && (
            <div className="notes-rec-tabs">
              <button
                className={`notes-mode-button ${recTab === 'note' ? 'notes-mode-button-active' : ''}`}
                onClick={() => setRecTab('note')}
              >
                Note
              </button>
              <button
                className={`notes-mode-button ${recTab === 'transcript' ? 'notes-mode-button-active' : ''}`}
                onClick={() => setRecTab('transcript')}
              >
                Live transcript
              </button>
            </div>
          )}

          <Button
            intent="ghost"
            size="compact"
            leadingIcon={<Sparkles />}
            title="Ask questions across your notes"
            onClick={onToggleChat}
          >
            Ask
          </Button>

          {recordingHere ? (
            <div className="notes-rec-indicator">
              {recordingHere.phase === 'recording' && (
                <>
                  <span className="recording-dot" aria-hidden="true" />
                  <RecordingClock startedAt={recordingHere.startedAt} />
                </>
              )}
              {recordingHere.phase === 'structuring' ? (
                <WorkingText>Structuring…</WorkingText>
              ) : (
                <Button
                  intent="danger"
                  size="compact"
                  leadingIcon={<Square />}
                  onClick={onStopRecording}
                >
                  Stop
                </Button>
              )}
            </div>
          ) : (
            <IconButton
              label={
                recording
                  ? 'A recording is already in progress in another topic'
                  : selectedNotePath
                    ? 'Record — the dictation appends to this lesson on stop'
                    : 'Select or create a lesson first'
              }
              disabled={!!recording || !selectedNotePath}
              onClick={onStartRecording}
            >
              <Mic />
            </IconButton>
          )}
        </div>

        {/* The editor stays mounted while the transcript tab is up, so the
            cursor and any unsaved typing survive tab switches */}
        <div className="notes-editor-stack" style={{ display: showEditorStack ? 'flex' : 'none' }}>
          {selectedNotePath ? (
            <NoteEditor
              key={selectedNotePath}
              path={selectedNotePath}
              pendingAppend={pendingAppend}
              onAppendApplied={onAppendApplied}
            />
          ) : (
            <div className="empty-state">
              <h2>
                {subject} / {topic.name}
              </h2>
              <p>Select a lesson on the left, or create one with the New lesson button — then type or record.</p>
            </div>
          )}
        </div>
        {recordingHere && recTab === 'transcript' && <RecordingPanel rec={recordingHere} />}
      </div>
    </div>
  )
}
