import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { ClipboardPaste, Headphones, Mic, Plus, Sparkles, Square, X } from 'lucide-react'
import { Button, Dot, IconButton, Row, WorkingText } from './ui'
import type { Extension } from '@codemirror/state'
import {
  parseNote,
  serializeNote,
  type NoteFrontmatter,
  type NoteSource,
  type NoteStyle,
  type NotesTopic,
  type SttSource
} from '../../../shared/notes'
import type { TopicRef } from './NotesSidebar'

const AUTOSAVE_MS = 800

/** App-wide dictation state — one recording at a time, owned by App. A
 * recording is bound to the lesson it was started on and appends into it.
 * `source` is what the sidecar captures (mic vs device + mic); `style` is
 * how the structuring pass reads the transcript (lecture vs meeting). */
export type RecordingState =
  | { phase: 'loading'; ref: TopicRef; notePath: string; source: SttSource; style: NoteStyle }
  | {
      phase: 'recording'
      ref: TopicRef
      notePath: string
      source: SttSource
      style: NoteStyle
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
  theme,
  pendingAppend,
  onAppendApplied
}: {
  path: string
  theme: Extension
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

  // Debounced autosave; also flush on unmount (lesson switch, workflow switch).
  // The flush must go through a ref: cleanup of an effect depending on `save`
  // would run the stale closure on every keystroke, saving one edit behind.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!loaded || !dirty.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(save, AUTOSAVE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [loaded, title, body, save])
  useEffect(() => () => saveRef.current(), [])

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
            theme={theme}
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

/**
 * Session record button: a popover with the two independent choices — what
 * to capture (mic alone for in-person, device + mic for online) and how the
 * transcript is structured (lecture vs meeting). Any combination is valid;
 * an in-person meeting is mic + meeting. Portalled like Select's menu so no
 * ancestor overflow can clip it.
 */
function RecordSessionButton({
  disabled,
  label,
  onStart
}: {
  disabled: boolean
  label: string
  onStart: (source: SttSource, style: NoteStyle) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [source, setSource] = useState<SttSource>('mix')
  const [style, setStyle] = useState<NoteStyle>('lecture')
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const close = (): void => setOpen(false)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const sources: { value: SttSource; label: string; detail: string }[] = [
    { value: 'mic', label: 'Mic', detail: 'In-person — just your microphone' },
    { value: 'mix', label: 'Device + mic', detail: 'Online — computer audio and your voice' },
    { value: 'system', label: 'Device only', detail: "Computer audio — you won't be transcribed" }
  ]
  const styles: { value: NoteStyle; label: string; detail: string }[] = [
    { value: 'lecture', label: 'Lecture', detail: 'Structured as lesson notes' },
    { value: 'meeting', label: 'Meeting', detail: 'Topics, decisions, action items' }
  ]

  return (
    <>
      <span ref={triggerRef} className="notes-record-session">
        <IconButton
          label={label}
          disabled={disabled}
          onClick={() => {
            const r = triggerRef.current?.getBoundingClientRect()
            if (!r) return
            setRect(r)
            setOpen((o) => !o)
          }}
        >
          <Headphones />
        </IconButton>
      </span>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            className="notes-record-menu"
            style={{ top: rect.bottom + 4, right: window.innerWidth - rect.right }}
          >
            <span className="notes-record-group-label">Capture</span>
            {sources.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`notes-record-option ${source === o.value ? 'notes-record-option-selected' : ''}`}
                onClick={() => setSource(o.value)}
              >
                <span className="notes-record-option-label">{o.label}</span>
                <span className="notes-record-option-detail">{o.detail}</span>
              </button>
            ))}
            <span className="notes-record-group-label">Structure as</span>
            {styles.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`notes-record-option ${style === o.value ? 'notes-record-option-selected' : ''}`}
                onClick={() => setStyle(o.value)}
              >
                <span className="notes-record-option-label">{o.label}</span>
                <span className="notes-record-option-detail">{o.detail}</span>
              </button>
            ))}
            <Button
              intent="primary"
              size="compact"
              className="notes-record-start"
              onClick={() => {
                setOpen(false)
                onStart(source, style)
              }}
            >
              Start recording
            </Button>
          </div>,
          document.body
        )}
    </>
  )
}

const SOURCE_LABEL: Record<SttSource, string> = {
  mic: 'Mic',
  mix: 'Device + mic',
  system: 'Device only'
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
            {rec.source !== 'mic'
              ? `Starting ${SOURCE_LABEL[rec.source].toLowerCase()} capture… the first use asks for the one-time System Audio Recording permission.`
              : 'Loading Whisper model… first run downloads it (~630 MB), later runs are instant.'}
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
        <span className="recording-source-label">
          {SOURCE_LABEL[rec.source]} · {rec.style}
        </span>
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
  /** Appearance-driven CodeMirror theme for the lesson editor */
  editorTheme: Extension
  recording: RecordingState | null
  pendingAppend: PendingAppend | null
  onAppendApplied: (id: number) => void
  onToggleChat: () => void
  onStartRecording: (source: SttSource, style: NoteStyle) => void
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
  editorTheme,
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
                  <Dot tone="danger" pulse />
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
            <>
              <IconButton
                label={
                  recording
                    ? 'A recording is already in progress in another topic'
                    : selectedNotePath
                      ? 'Dictate — the dictation appends to this lesson on stop'
                      : 'Select or create a lesson first'
                }
                disabled={!!recording || !selectedNotePath}
                onClick={() => onStartRecording('mic', 'lecture')}
              >
                <Mic />
              </IconButton>
              <RecordSessionButton
                disabled={!!recording || !selectedNotePath}
                label={
                  recording
                    ? 'A recording is already in progress in another topic'
                    : selectedNotePath
                      ? 'Record a session — choose capture and lecture/meeting'
                      : 'Select or create a lesson first'
                }
                onStart={onStartRecording}
              />
            </>
          )}
        </div>

        {/* The editor stays mounted while the transcript tab is up, so the
            cursor and any unsaved typing survive tab switches */}
        <div className="notes-editor-stack" style={{ display: showEditorStack ? 'flex' : 'none' }}>
          {selectedNotePath ? (
            <NoteEditor
              key={selectedNotePath}
              path={selectedNotePath}
              theme={editorTheme}
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
