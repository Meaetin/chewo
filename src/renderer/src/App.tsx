import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderTree,
  GitBranch,
  Play,
  Plus,
  Settings,
  Terminal,
  X
} from 'lucide-react'
import { ChatPane } from './components/chat/ChatPane'
import { DEFAULT_APPEARANCE, type AppearanceSettings } from '../../shared/appearance'
import {
  agentDef,
  AGENT_IDS,
  DEFAULT_AGENTS,
  sessionEffort,
  sessionModel,
  type AgentAssignments,
  type AgentId,
  type AgentModel,
  type EffortLevel
} from '../../shared/agents'
import type { SessionMeta, Source } from '../../shared/adapter/types'
import type { WorktreeState } from '../../main/worktrees'
import {
  assignProject,
  sessionInProject,
  type AgentSettings,
  type Project,
  type ProjectSettings,
  type ProjectsFile,
  type SavedTerminal,
  type Workflow,
  type Worktree
} from '../../shared/projects'
import {
  type NoteSource,
  type NoteStyle,
  type NotesTree,
  type SttSource
} from '../../shared/notes'
import {
  DEFAULT_STT_SETTINGS,
  type PendingRecovery,
  type SttSettings
} from '../../shared/stt'
import {
  composeCardPrompt,
  GENERAL_SCOPE,
  projectScopeDir,
  type BoardFile,
  type TodoStatus
} from '../../shared/todos'
import { Sidebar } from './components/Sidebar'
import { NotesSidebar, type TopicRef } from './components/NotesSidebar'
import {
  NotesWorkspace,
  type PendingAppend,
  type RecordingState
} from './components/NotesWorkspace'
import { NotesChat } from './components/NotesChat'
import { WorkflowSwitcher } from './components/WorkflowSwitcher'
import { TodoSidebar } from './components/TodoSidebar'
import { TodoBoard, type UpdateCardPayload } from './components/TodoBoard'
import { TerminalPane } from './components/TerminalPane'
import { CapabilitiesView } from './components/CapabilitiesView'
import { FileTreePanel } from './components/FileTreePanel'
import { FileEditor } from './components/FileEditor'
import type { ChangedFile, StaleCheckout } from '../../main/git'
import { GitPanel, type GitSelection } from './components/GitPanel'
import { GitDiffView } from './components/GitDiffView'
import { UpdateButton } from './components/UpdateButton'
import { TabOverflowButton, type TabMenuItem } from './components/TabOverflowMenu'
import { stripEdges } from './tabStrip'
import { ShipButton } from './components/ShipButton'
import { ShipModal } from './components/ShipModal'
import { branchNameFor } from '../../shared/branch-names'
import { splitComposed, withImagePaths } from '../../shared/attachments'
import type { ShipPreview, ShipSuccess } from '../../main/git-ship'
import { useGitDirtyCount, useGitStatus } from './useGitStatus'
import { WorktreeCreateModal } from './components/WorktreeModals'
import { SectionSettingsModal } from './components/SectionSettingsModal'
import { AppSettings, type SettingsPane } from './components/settings/AppSettings'
import { applyAppearance } from './theme/applyAppearance'
import { makeTerminalTheme } from './theme/terminalTheme'
import { makeEditorTheme } from './theme/editorTheme'
import { Badge, ContextMenu, Dot, IconButton } from './components/ui'
import { reorderOpenFiles } from './fileTabs'

export type PaneSource = Source | 'shell'

export interface TerminalTab {
  /** Pane id — allocated from one counter in main, whichever runtime backs it */
  termId: number
  projectId: string | null
  source: PaneSource
  /**
   * Which runtime is behind this pane. Both are the same agent CLI: 'terminal'
   * is the pty, 'chat' drives it over JSON and renders a conversation. The tab
   * strip treats them identically; only the pane body and the kill call differ.
   */
  mode: 'terminal' | 'chat'
  label: string
  /** A card run's prompt, handed to the chat pane to submit on mount.
   *  Transient — never persisted, or reopening a session would re-run it. */
  initialPrompt?: string
  /** Staged image paths belonging to `initialPrompt`; equally transient */
  initialImages?: string[]
  /**
   * The conversation this pane was opened to *resume*, as opposed to
   * `sessionId`, which a fresh pane fills in once the CLI announces itself.
   * A chat pane reads this one's transcript to show history, so it must never
   * be set from a session the pane started on its own — that would render
   * every live message twice.
   */
  resumeSessionId?: string
  sessionId?: string
  /** Pane runs in an isolated worktree — gets the merge button, keeps its ⎇ label */
  worktreeId?: string
  /**
   * Where this session's work should land, chosen in the pane's own setup row
   * before the first message. 'separate' means "cut a worktree for this" —
   * deferred until the user has typed something, because the branch is named
   * after the task. Absent (and after the first message) means the checkout it
   * opened in.
   */
  branchMode?: 'current' | 'separate'
  /**
   * Start point for that branch, when the setup row named one. Absent means
   * the default, which is deliberately *not* stored as a ref: resolving it is
   * a fetch plus a local-vs-remote freshness check that only makes sense at
   * the moment the worktree is cut, and pinning today's answer onto the tab
   * would freeze a session on whatever `origin/main` was when the pane opened.
   */
  baseBranch?: string
  /**
   * Model and reasoning effort for the session, also from the setup row.
   * Absent means "whatever `sessionModel`/`sessionEffort` resolve for this
   * agent" — an explicit id would go stale the moment a CLI update renames a
   * model, and the resolver is shared with the picker so the label and the
   * spawn cannot disagree.
   */
  model?: string
  effort?: EffortLevel
  /**
   * No process behind this pane yet. Its composer is the only live part: the
   * CLI is spawned on the first message, once the setup row's answers are
   * final. Nothing before that point is worth a running agent, and spawning
   * early would mean re-spawning every time one of those answers changed.
   */
  pending?: boolean
  exited: boolean
}

/** A repo's branches, as the setup row's "branch from" picker needs them */
interface ProjectBranches {
  current: string
  local: string[]
  remote: string[]
}

type MainView =
  | { kind: 'terminal'; termId: number }
  | { kind: 'capabilities' }
  | { kind: 'empty' }

/** A file open in the editor layer — never a session tab */
export interface OpenFile {
  /** Absolute path — the identity everywhere */
  path: string
  name: string
}

/** One-shot cursor jump after opening a file at `path:line[:col]` — seq lets repeat clicks re-fire */
export interface GotoTarget {
  path: string
  line: number
  col?: number
  seq: number
}

/** Editor-layer state for one section (project or Home) */
interface SectionFiles {
  openFiles: OpenFile[]
  /** Non-null → the editor covers the terminal layer */
  activePath: string | null
}

const EMPTY_SECTION_FILES: SectionFiles = { openFiles: [], activePath: null }

/** Is `path` the folder/file at `base`, or something inside it? */
const isAtOrUnder = (path: string, base: string): boolean =>
  path === base || path.startsWith(base + '/')

/** Passive dirty-count pill on a worktree session tab — polled, no watcher */
function TabDirtyPill({ root }: { root: string | null }): React.JSX.Element | null {
  const count = useGitDirtyCount(root)
  if (count === 0) return null
  return (
    <span
      className="terminal-tab-dirty"
      title={`${count} uncommitted change${count === 1 ? '' : 's'} in this worktree`}
    >
      {count}
    </span>
  )
}

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [draggedTermId, setDraggedTermId] = useState<number | null>(null)
  /** Where to open `+`'s checkout menu — viewport coords, null while closed */
  const [shellMenuAt, setShellMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [view, setView] = useState<MainView>({ kind: 'empty' })
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [homeTerminals, setHomeTerminals] = useState<SavedTerminal[]>([])
  const [homeSettings, setHomeSettings] = useState<AgentSettings>({})
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  /** Panes whose worktree is being cut right now — they show a notice, not a composer */
  const [cuttingBranch, setCuttingBranch] = useState<Set<number>>(new Set())
  /** `origin/main` per project path — what an isolated session will be cut from */
  const [defaultBases, setDefaultBases] = useState<Map<string, string | null>>(new Map())
  /** Every other branch a session could be cut from, per project path */
  const [branchLists, setBranchLists] = useState<Map<string, ProjectBranches>>(new Map())
  /** Projects whose own checkout is parked on an already-merged branch */
  const [staleCheckouts, setStaleCheckouts] = useState<Map<string, StaleCheckout>>(new Map())
  /**
   * Each agent's model catalog, for the composer's picker. Claude's is the
   * static alias list; Codex's is read from `codex debug models`, which is why
   * this is fetched rather than imported. Main caches it for the session.
   */
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, AgentModel[]>>({})
  const [wtCreateOpen, setWtCreateOpen] = useState(false)
  /**
   * The Ship review, in two halves. `shipReading` is the root whose change is
   * being read — the button spins on it — and `shipReview` is the finished
   * result the dialog opens onto. Splitting them is what keeps the dialog from
   * appearing on an empty "Reading the change…" for several seconds: the read
   * costs two GitHub API calls and a model call, and all of that belongs
   * behind the button, not behind a modal that is already in your way.
   */
  const [shipReading, setShipReading] = useState<string | null>(null)
  const [shipReview, setShipReview] = useState<{ root: string; preview: ShipPreview } | null>(null)
  /** Section whose settings modal is open — string id, or null for Home */
  const [settingsFor, setSettingsFor] = useState<{ id: string | null } | null>(null)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [settingsPane, setSettingsPane] = useState<SettingsPane>('presets')
  const [appearance, setAppearance] = useState<AppearanceSettings>(DEFAULT_APPEARANCE)
  const [agents, setAgents] = useState<AgentAssignments>(DEFAULT_AGENTS)
  const [stt, setStt] = useState<SttSettings>(DEFAULT_STT_SETTINGS)
  // Whether a Deepgram key is stored. Dictation is disabled until it is —
  // the alternative is an open mic with nowhere to send the audio.
  const [sttReady, setSttReady] = useState(false)
  /** Recordings whose stream died; their audio is still on disk */
  const [sttPending, setSttPending] = useState<PendingRecovery[]>([])
  const settingsLoaded = useRef(false)
  /** `action` turns the toast into an offer — "Open PR" after a ship */
  const [toast, setToast] = useState<{
    text: string
    action?: { label: string; onClick: () => void }
  } | null>(null)
  const [workflow, setWorkflow] = useState<Workflow>('code')
  /** Agent the card modal's run button launches — sticky across restarts */
  const [todoRunAgent, setTodoRunAgent] = useState<Source>('claude')
  const [notesTree, setNotesTree] = useState<NotesTree | null>(null)
  const [notesSel, setNotesSel] = useState<TopicRef | null>(null)
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null)
  const [recording, setRecording] = useState<RecordingState | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  /** Board scope in the todo workflow — a project id, or null for General */
  const [todoScopeId, setTodoScopeId] = useState<string | null>(null)
  const [todoBoard, setTodoBoard] = useState<BoardFile | null>(null)
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  /** What the git diff layer shows — a working-tree file or a commit */
  const [gitSel, setGitSel] = useState<GitSelection | null>(null)
  // Editor-layer files per section, keyed by projectId ?? 'home'. Session-
  // lifetime only — deliberately not persisted to the projects file.
  const [filesBySection, setFilesBySection] = useState<Map<string, SectionFiles>>(new Map())
  const [pendingAppend, setPendingAppend] = useState<PendingAppend | null>(null)
  const appendSeq = useRef(0)
  const recordingRef = useRef<RecordingState | null>(null)
  recordingRef.current = recording
  // Live mirrors for the stt event handler (registered once, must not go stale)
  const workflowRef = useRef<Workflow>('code')
  workflowRef.current = workflow
  const notesSelRef = useRef<TopicRef | null>(null)
  notesSelRef.current = notesSel
  const sttModelRef = useRef(DEFAULT_STT_SETTINGS.model)
  sttModelRef.current = stt.model
  const refreshSttStatusRef = useRef<() => Promise<void>>(async () => {})
  const selectedNotePathRef = useRef<string | null>(null)
  selectedNotePathRef.current = selectedNotePath
  const notesRoot = useRef<string | undefined>(undefined)
  const todoHotkey = useRef<string | undefined>(undefined)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)
  // Last-viewed terminal per section, so switching sections lands you back
  // where you were instead of on an empty state
  const lastViewedTerm = useRef(new Map<string | null, number>())

  const showToast = useCallback(
    (text: string, action?: { label: string; onClick: () => void }) => {
      setToast({ text, ...(action && { action }) })
      if (toastTimer.current) clearTimeout(toastTimer.current)
      // An offer needs longer than a status line — it is only useful while it's up
      toastTimer.current = setTimeout(() => setToast(null), action ? 20000 : 8000)
    },
    []
  )

  /** `pane` lets a nudge elsewhere in the app land on the right section. */
  const openAppSettings = useCallback((pane: SettingsPane = 'presets') => {
    setSettingsPane(pane)
    setAppSettingsOpen(true)
  }, [])

  const refresh = useCallback(async () => {
    const result = await window.api.listSessions()
    setSessions(result.sessions)
  }, [])

  const refreshNotes = useCallback(async () => {
    setNotesTree(await window.api.notesScan())
  }, [])

  /**
   * stt 'final' → raw transcript appended to the lesson's .raw.md twin, one
   * claude -p pass structures it as a continuation, and the result appends
   * into the lesson: through the open editor when it's mounted (so typing is
   * never clobbered), else straight to the file.
   */
  /**
   * Structures a transcript and lands it in its lesson — the shared tail of a
   * live dictation and of a recording recovered after its stream died.
   *
   * An open editor receives it as a pending append rather than a file write,
   * so typing during a recording is never clobbered; a lesson that isn't on
   * screen is written directly.
   */
  const appendTranscript = useCallback(
    async (
      lessonPath: string,
      transcript: string,
      durationS: number,
      style: NoteStyle,
      verb: string
    ) => {
      const res = await window.api.notesStructure({
        lessonPath,
        transcript,
        durationS,
        sttModel: sttModelRef.current,
        style
      })

      // A failed pass still lands in the lesson — as the raw transcript
      const when = new Date().toLocaleString()
      const stamp = res.ok
        ? `*${verb} ${when}*`
        : `*${verb} ${when} — structuring failed, raw transcript:*`
      const addition = `---\n\n${stamp}\n\n${(res.ok ? (res.body ?? '') : transcript).trim()}`

      const editorMounted =
        workflowRef.current === 'notes' && selectedNotePathRef.current === lessonPath
      if (editorMounted) {
        setPendingAppend({ id: ++appendSeq.current, path: lessonPath, text: addition })
      } else {
        try {
          const existing = await window.api.notesRead(lessonPath)
          await window.api.notesWrite(
            lessonPath,
            existing.replace(/\s+$/, '') + '\n\n' + addition + '\n'
          )
        } catch {
          showToast('Lesson file is gone — the transcript is kept in its .raw.md twin.')
        }
      }

      void refreshNotes()
      if (!res.ok) showToast(`Structuring failed: ${res.error ?? 'unknown'} — appended raw transcript.`)
    },
    [refreshNotes, showToast]
  )

  const finalizeRecording = useCallback(
    async (text: string, durationS: number) => {
      const rec = recordingRef.current
      if (!rec) return
      const transcript = text.trim()
      if (!transcript) {
        showToast('Dictation stopped — no speech captured.')
        setRecording(null)
        return
      }
      const style = rec.phase === 'structuring' ? 'lecture' : rec.style
      const verb = rec.phase !== 'structuring' && rec.source !== 'mic' ? 'Recorded' : 'Dictated'
      setRecording({ phase: 'structuring', ref: rec.ref, notePath: rec.notePath })
      await appendTranscript(rec.notePath, transcript, durationS, style, verb)
      setRecording(null)
    },
    [appendTranscript, showToast]
  )

  const onAppendApplied = useCallback((id: number) => {
    setPendingAppend((p) => (p && p.id === id ? null : p))
  }, [])

  useEffect(() => {
    void refresh()
    void refreshNotes()
    void window.api.loadProjects().then((file: ProjectsFile) => {
      setProjects(file.projects)
      setSelectedProjectId(file.selectedProjectId)
      setHiddenIds(new Set(file.hiddenSessionIds))
      setHomeTerminals(file.homeTerminals)
      setHomeSettings(file.homeSettings)
      setWorktrees(file.worktrees)
      setWorkflow(file.workflow ?? 'code')
      setTodoRunAgent(file.todoRunAgent ?? 'claude')
      notesRoot.current = file.notesRoot
      todoHotkey.current = file.todoHotkey
      loaded.current = true
    })
    void window.api.loadSettings().then((file) => {
      setAppearance(file.appearance)
      setAgents(file.agents)
      setStt(file.stt)
      settingsLoaded.current = true
    })
    const offNotes = window.api.onNotesChanged(() => void refreshNotes())
    const offStt = window.api.onSttEvent((ev) => {
      switch (ev.event) {
        // The Deepgram handshake, before the mic opens. Sub-second, so the
        // panel copy is a reassurance rather than something to wait through.
        case 'connecting':
          break
        case 'ready':
          setRecording((r) =>
            r && r.phase === 'connecting'
              ? {
                  phase: 'recording',
                  ref: r.ref,
                  notePath: r.notePath,
                  source: r.source,
                  style: r.style,
                  confirmed: '',
                  tail: '',
                  level: 0,
                  startedAt: Date.now()
                }
              : r
          )
          break
        case 'level':
          setRecording((r) => (r && r.phase === 'recording' ? { ...r, level: ev.rms ?? 0 } : r))
          break
        case 'partial':
          setRecording((r) =>
            r && r.phase === 'recording'
              ? { ...r, confirmed: ev.confirmed ?? '', tail: ev.tail ?? '' }
              : r
          )
          break
        case 'final':
          void finalizeRecording(ev.text ?? '', ev.duration_s ?? 0)
          break
        case 'error':
          showToast(`Dictation: ${ev.message ?? 'unknown error'}`)
          setRecording((r) => (r && r.phase === 'structuring' ? r : null))
          // A dropped stream leaves its audio on disk, so the pending list
          // the Voice pane shows has just changed.
          void refreshSttStatusRef.current()
          break
      }
    })
    const offToast = window.api.onAppToast((message) => showToast(message))
    const offChanged = window.api.onSessionsChanged((result) => setSessions(result.sessions))
    const offExit = window.api.onTermExit(({ id }) => {
      setTabs((t) => t.map((tab) => (tab.termId === id ? { ...tab, exited: true } : tab)))
    })
    const offBound = window.api.onTermBound(({ id, sessionId, title }) => {
      setTabs((t) =>
        t.map((tab) =>
          tab.termId === id
            ? // Worktree tabs keep their ⎇ task label — that's how you tell N agents apart
              { ...tab, sessionId, label: tab.worktreeId ? tab.label : title.slice(0, 30) }
            : tab
        )
      )
    })
    const offHandoff = window.api.onHandoff(({ to, from, note, nudged }) => {
      const summary = note ? ` — “${note.slice(0, 80)}${note.length > 80 ? '…' : ''}”` : ''
      showToast(
        nudged
          ? `Handoff ${from} → ${to}${summary}. Typed “check your inbox” into the ${to} terminal — press Enter there to receive it.`
          : `Handoff ${from} → ${to}${summary}. No ${to} terminal open — it's waiting in the inbox.`
      )
    })
    return () => {
      offNotes()
      offStt()
      offToast()
      offChanged()
      offExit()
      offBound()
      offHandoff()
    }
  }, [refresh, refreshNotes, finalizeRecording, showToast])

  // Persist projects + remembered terminals whenever state settles.
  // A section's saved list = its live bound tabs + dormant leftovers.
  useEffect(() => {
    if (!loaded.current) return
    const savedFor = (projectId: string | null, dormant: SavedTerminal[]): SavedTerminal[] => {
      const live: SavedTerminal[] = tabs
        // Shell panes have no session to resume — only agent tabs persist
        .filter(
          (t): t is TerminalTab & { source: Source; sessionId: string } =>
            t.projectId === projectId && !!t.sessionId && t.source !== 'shell'
        )
        .map((t) => ({
          source: t.source,
          sessionId: t.sessionId,
          label: t.label,
          worktreeId: t.worktreeId,
          mode: t.mode
        }))
      const liveIds = new Set(live.map((t) => t.sessionId))
      return [...live, ...dormant.filter((t) => !liveIds.has(t.sessionId))]
    }
    const file: ProjectsFile = {
      projects: projects.map((p) => ({ ...p, terminals: savedFor(p.id, p.terminals) })),
      selectedProjectId,
      hiddenSessionIds: [...hiddenIds],
      homeTerminals: savedFor(null, homeTerminals),
      homeSettings,
      worktrees,
      workflow,
      notesRoot: notesRoot.current,
      todoHotkey: todoHotkey.current,
      todoRunAgent
    }
    void window.api.saveProjects(file)
  }, [
    projects,
    tabs,
    selectedProjectId,
    hiddenIds,
    homeTerminals,
    homeSettings,
    worktrees,
    workflow,
    todoRunAgent
  ])

  // Keep the worktree records in step with git itself. Records whose checkout
  // git no longer lists are dropped (someone ran `git worktree remove`), and
  // checkouts under our root that we have no record of are adopted so they
  // stay reachable from the sidebar — a build with its own projects.json, or a
  // pane closed before the record was written, must not strand a branch.
  // Projects git can't answer for are left exactly as they are.
  // Serialized so the pass re-runs on a real change of projects, not on every
  // render that hands back a new array
  const projectRoots = JSON.stringify(projects.map((p) => [p.id, p.path]))
  const reconcileSeq = useRef(0)
  const reconcileWorktrees = useCallback(async () => {
    const seq = ++reconcileSeq.current
    {
      const scans = await Promise.all(
        (JSON.parse(projectRoots) as [string, string][]).map(async ([id, path]) => ({
          id,
          res: await window.api.worktreeList(path)
        }))
      )
      // A newer pass — or unmount — superseded this one while git answered
      if (seq !== reconcileSeq.current) return
      setWorktrees((prev) => {
        const next: Worktree[] = []
        const scanned = new Set<string>()
        let changed = false
        for (const { id, res } of scans) {
          if (!res.ok) continue
          scanned.add(id)
          const records = prev.filter((w) => w.projectId === id)
          const byPath = new Map(records.map((w) => [w.path, w]))
          for (const found of res.worktrees) {
            const rec = byPath.get(found.path)
            if (!rec) {
              changed = true
              next.push({
                id: crypto.randomUUID(),
                projectId: id,
                taskName: found.taskName,
                branch: found.branch,
                path: found.path,
                // Same fallback `git worktree add` itself used with no base
                baseBranch: res.head,
                baseCommit: found.baseCommit,
                createdAt: new Date().toISOString()
              })
            } else if (
              (found.branch && found.branch !== rec.branch) ||
              (found.baseCommit && !rec.baseCommit)
            ) {
              changed = true
              next.push({
                ...rec,
                branch: found.branch || rec.branch,
                baseCommit: rec.baseCommit ?? found.baseCommit
              })
            } else {
              next.push(rec)
            }
          }
          const onDisk = new Set(res.worktrees.map((f) => f.path))
          if (records.some((w) => !onDisk.has(w.path))) changed = true
        }
        for (const w of prev) if (!scanned.has(w.projectId)) next.push(w)
        return changed ? next : prev
      })
    }
  }, [projectRoots])

  // Also on window focus: agents and terminals create and remove worktrees
  // outside this window all the time, and nothing notifies it when they do.
  useEffect(() => {
    void reconcileWorktrees()
    const onFocus = (): void => void reconcileWorktrees()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      reconcileSeq.current++ // drop whatever is still in flight
    }
  }, [reconcileWorktrees])

  // ---------- appearance ----------

  // Live re-theme: CSS tokens for the whole UI, plus derived themes for the
  // two JS-painted surfaces (xterm, CodeMirror)
  useEffect(() => applyAppearance(appearance), [appearance])
  const terminalTheme = useMemo(() => makeTerminalTheme(appearance), [appearance])
  const editorTheme = useMemo(() => makeEditorTheme(appearance), [appearance])

  // Persist debounced — dragging the macOS color picker fires per-frame changes
  useEffect(() => {
    if (!settingsLoaded.current) return
    const t = setTimeout(
      () => void window.api.saveSettings({ appearance, agents, stt }),
      400
    )
    return () => clearTimeout(t)
  }, [appearance, agents, stt])

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null

  // ---------- file explorer ----------

  const sectionKey = selectedProjectId ?? 'home'
  const sectionFiles = filesBySection.get(sectionKey) ?? EMPTY_SECTION_FILES
  // Every section's open files — the editor watches/keeps buffers for all of
  // them so switching sections loses nothing
  const allOpenPaths = useMemo(
    () => [
      ...new Set([...filesBySection.values()].flatMap((s) => s.openFiles.map((f) => f.path)))
    ],
    [filesBySection]
  )
  /** Editor covers the terminal layer; `view` still describes what's underneath */
  const editorVisible = workflow === 'code' && sectionFiles.activePath !== null

  // The tree follows the active tab's effective root: an isolated session
  // browses its worktree, not the main checkout (same resolution as wakeDormant)
  const activeTab = view.kind === 'terminal' ? tabs.find((t) => t.termId === view.termId) : undefined
  const activeWorktree = activeTab?.worktreeId
    ? worktrees.find((w) => w.id === activeTab.worktreeId)
    : undefined
  // The checkout `+` offers as an alternative to main. A pending session has
  // none of its own — it is only borrowing the shared one until its first
  // message — so there is nothing to choose and `+` stays a single click.
  const shellWorktree = activeTab?.pending ? undefined : activeWorktree
  const treeRoot = activeWorktree?.path ?? selectedProject?.path ?? window.api.homeDir
  const treeRootLabel = activeWorktree
    ? `⎇ ${activeWorktree.taskName}`
    : (selectedProject?.name ?? 'Home')

  /**
   * An isolated session that has not cut its branch yet is only *standing* in
   * the shared checkout — the branch there is whatever you last left the
   * project on, and is emphatically not this session's. Showing it was what
   * made every new session look like it had inherited an old branch. What the
   * branch will actually be cut from is the honest answer, so the chip says
   * that instead, and Update/Ship stay away until there is a branch to act on.
   */
  const pendingBase =
    activeTab && activeTab.pending && activeTab.branchMode === 'separate' && selectedProject
      ? (activeTab.baseBranch ?? defaultBases.get(selectedProject.path) ?? 'the default branch')
      : null

  // ---------- git panel ----------

  // Git visibility follows the same root as the file tree, but only for
  // project/worktree sections — never a recursive watcher on $HOME itself
  const gitRoot =
    workflow === 'code' && (activeWorktree || selectedProject) ? treeRoot : null
  const repoStatus = useGitStatus(gitRoot)
  const gitRootRef = useRef<string | null>(null)
  gitRootRef.current = gitRoot
  const dirtyCount = repoStatus?.ok && repoStatus.isRepo ? repoStatus.files.length : 0

  // The diff layer describes one root's state — switching tab/section drops it
  useEffect(() => setGitSel(null), [treeRoot])

  const gotoSeq = useRef(0)
  const [gotoTarget, setGotoTarget] = useState<GotoTarget | null>(null)

  const openFile = useCallback(
    (path: string, goto?: { line: number; col?: number }) => {
      setFilesBySection((prev) => {
        const cur = prev.get(sectionKey) ?? EMPTY_SECTION_FILES
        const openFiles = cur.openFiles.some((f) => f.path === path)
          ? cur.openFiles
          : [...cur.openFiles, { path, name: path.split('/').pop() ?? path }]
        return new Map(prev).set(sectionKey, { openFiles, activePath: path })
      })
      if (goto) setGotoTarget({ path, line: goto.line, col: goto.col, seq: ++gotoSeq.current })
      // The editor and the diff layer share the space over the terminal
      setGitSel(null)
    },
    [sectionKey]
  )

  const activateFile = useCallback(
    (path: string | null) => {
      setFilesBySection((prev) => {
        const cur = prev.get(sectionKey) ?? EMPTY_SECTION_FILES
        if (cur.activePath === path) return prev
        return new Map(prev).set(sectionKey, { ...cur, activePath: path })
      })
    },
    [sectionKey]
  )

  const closeFile = useCallback(
    (path: string) => {
      setFilesBySection((prev) => {
        const cur = prev.get(sectionKey)
        if (!cur) return prev
        const idx = cur.openFiles.findIndex((f) => f.path === path)
        if (idx === -1) return prev
        const openFiles = cur.openFiles.filter((f) => f.path !== path)
        // Closing the active chip focuses its left neighbour, then right, then
        // falls back to the terminal
        const activePath =
          cur.activePath === path
            ? (openFiles[idx - 1] ?? openFiles[idx])?.path ?? null
            : cur.activePath
        return new Map(prev).set(sectionKey, { openFiles, activePath })
      })
    },
    [sectionKey]
  )

  const reorderFile = useCallback(
    (path: string, targetPath: string) => {
      setFilesBySection((prev) => {
        const cur = prev.get(sectionKey)
        if (!cur) return prev
        const openFiles = reorderOpenFiles(cur.openFiles, path, targetPath)
        if (openFiles === cur.openFiles) return prev
        return new Map(prev).set(sectionKey, { ...cur, openFiles })
      })
    },
    [sectionKey]
  )

  const reorderTab = useCallback((termId: number, targetTermId: number) => {
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.termId === termId)
      const to = prev.findIndex((t) => t.termId === targetTermId)
      if (from === -1 || to === -1 || from === to) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  /** A path (file or whole dir) was trashed — close its chips in every section */
  const closeFilesUnder = useCallback((path: string) => {
    const gone = (p: string): boolean => p === path || p.startsWith(path + '/')
    setFilesBySection((prev) => {
      let changed = false
      const next = new Map<string, SectionFiles>()
      for (const [key, sf] of prev) {
        if (!sf.openFiles.some((f) => gone(f.path))) {
          next.set(key, sf)
          continue
        }
        changed = true
        const openFiles = sf.openFiles.filter((f) => !gone(f.path))
        const activePath =
          sf.activePath && gone(sf.activePath)
            ? (openFiles[openFiles.length - 1]?.path ?? null)
            : sf.activePath
        next.set(key, { openFiles, activePath })
      }
      return changed ? next : prev
    })
  }, [])

  /** A path was renamed — re-point chips (and chips under it, for dirs) */
  const renameOpenFiles = useCallback((oldPath: string, newPath: string) => {
    const moved = (p: string): string | null =>
      p === oldPath ? newPath : p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length) : null
    setFilesBySection((prev) => {
      let changed = false
      const next = new Map<string, SectionFiles>()
      for (const [key, sf] of prev) {
        if (!sf.openFiles.some((f) => moved(f.path))) {
          next.set(key, sf)
          continue
        }
        changed = true
        const openFiles = sf.openFiles.map((f) => {
          const to = moved(f.path)
          return to ? { path: to, name: to.split('/').pop() ?? to } : f
        })
        const activePath = sf.activePath ? (moved(sf.activePath) ?? sf.activePath) : null
        next.set(key, { openFiles, activePath })
      }
      return changed ? next : prev
    })
  }, [])

  // ⌘⇧E toggles the file tree, ⌘⇧G the git panel (mutually exclusive — one
  // left rail) anywhere in the code workflow — including with terminal focus
  // (xterm doesn't swallow them; see TerminalPane key handler)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        if (workflowRef.current === 'code') {
          setFileTreeOpen((o) => !o)
          setGitOpen(false)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (workflowRef.current === 'code' && gitRootRef.current) {
          setGitOpen((o) => !o)
          setFileTreeOpen(false)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        openAppSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openAppSettings])

  /**
   * Launch settings belong to the section the terminal lands in — never the
   * one that happens to be selected. Home (null) is a section like any other.
   */
  const settingsForSection = useCallback(
    (projectId: string | null): AgentSettings =>
      projectId === null ? homeSettings : (projects.find((p) => p.id === projectId) ?? {}),
    [projects, homeSettings]
  )

  // Tab bar shows only the selected section's terminals (Home when nothing
  // is selected). Terminals in other sections keep running — the sidebar
  // shows a live count per section so they stay discoverable.
  const visibleTabs = tabs.filter((t) => t.projectId === (selectedProject?.id ?? null))
  // Panes render in a stable termId order, decoupled from the reorderable tab
  // strip: moving a live terminal's DOM node corrupts its xterm renderer.
  const paneTabs = [...tabs].sort((a, b) => a.termId - b.termId)

  /**
   * Locate the transcript a resumed chat pane should open with. Returns
   * undefined for a fresh pane, and for a resumed one whose session file the
   * scan has not produced yet — in which case the pane simply opens without
   * history rather than blocking on it.
   */
  const resumeSourceFor = (
    tab: TerminalTab
  ): { sessionId: string; source: Source; filePath: string } | undefined => {
    if (!tab.resumeSessionId || tab.source === 'shell') return undefined
    const meta = sessions.find((s) => s.id === tab.resumeSessionId)
    return meta
      ? { sessionId: meta.id, source: meta.source, filePath: meta.filePath }
      : undefined
  }
  const liveCounts = new Map<string | null, number>()
  for (const t of tabs) liveCounts.set(t.projectId, (liveCounts.get(t.projectId) ?? 0) + 1)

  // Notes-chat and todo-voice runs create real Claude sessions with cwd
  // under the notes root / ~/.chewo — they're app plumbing, not coding
  // sessions, so keep them out of the coding sidebar entirely
  // (SPEC-NOTES.md §9, SPEC-TODOS.md §6).
  const chewoStore = `${window.api.homeDir}/.chewo`
  const inAppStore = (path: string | null): boolean =>
    !!path &&
    (path === chewoStore ||
      path.startsWith(chewoStore + '/') ||
      (!!notesTree && (path === notesTree.root || path.startsWith(notesTree.root + '/'))))
  const visibleSessions = sessions.filter((s) => !hiddenIds.has(s.id) && !inAppStore(s.project))
  const hiddenSessions = sessions.filter((s) => hiddenIds.has(s.id) && !inAppStore(s.project))

  // Remember which terminal was last viewed in each section
  useEffect(() => {
    if (view.kind !== 'terminal') return
    const tab = tabs.find((t) => t.termId === view.termId)
    if (tab) lastViewedTerm.current.set(tab.projectId, tab.termId)
  }, [view, tabs])

  // Sessions that currently have a live terminal — sidebar rows route to the
  // terminal instead of the transcript
  const liveSessionTabs = new Map(tabs.filter((t) => t.sessionId).map((t) => [t.sessionId!, t]))

  const hideSession = useCallback((id: string) => {
    setHiddenIds((prev) => new Set(prev).add(id))
  }, [])

  const restoreSession = useCallback((id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // Dormant (resumable) tabs show for the selected section only — Home's
  // when nothing is selected
  const liveSessionIds = new Set(tabs.map((t) => t.sessionId).filter(Boolean))
  const dormantTerminals = (selectedProject?.terminals ?? homeTerminals).filter(
    (t) => !liveSessionIds.has(t.sessionId)
  )

  /**
   * How much of the tab strip is off-screen. Tabs shrink to a floor and only
   * then scroll, and the scrollbar is hidden, so this is the only thing that
   * can say a session exists past the edge — it drives the edge fades and the
   * ⌄ overflow menu.
   */
  const tabStripRef = useRef<HTMLDivElement>(null)
  const [strip, setStrip] = useState({ left: false, right: false, overflowing: false, hidden: 0 })

  const measureStrip = useCallback(() => {
    const el = tabStripRef.current
    if (!el) return
    const edges = stripEdges({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth
    })
    // Rects, not offsetLeft: a tab's offsetParent is a positioned ancestor of
    // the scrollport, so its offset is not in the same space as scrollLeft.
    let hidden = 0
    if (edges.overflowing) {
      const box = el.getBoundingClientRect()
      for (const child of Array.from(el.children)) {
        const r = child.getBoundingClientRect()
        if (r.left < box.left - 1 || r.right > box.right + 1) hidden++
      }
    }
    setStrip((prev) =>
      prev.left === edges.left &&
      prev.right === edges.right &&
      prev.overflowing === edges.overflowing &&
      prev.hidden === hidden
        ? prev
        : { ...edges, hidden }
    )
  }, [])

  // Remeasure whenever the strip resizes (window, sidebar, panels) or its
  // contents change. A ResizeObserver on the scrollport catches the first two;
  // the tab counts in the deps catch the third.
  useEffect(() => {
    const el = tabStripRef.current
    if (!el) return
    measureStrip()
    const ro = new ResizeObserver(measureStrip)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  }, [measureStrip, workflow, visibleTabs.length, dormantTerminals.length])

  // Focusing a session that is scrolled out of the strip has to bring its tab
  // back, or the focused pane has no tab — the exact state the overflow menu
  // exists to rescue, reached by accident.
  useEffect(() => {
    if (view.kind !== 'terminal') return
    tabStripRef.current
      ?.querySelector(`[data-term-id="${view.termId}"]`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [view])

  const openTerminal = useCallback(
    async (opts: {
      source: PaneSource
      sessionId?: string
      cwd?: string | null
      label?: string
      projectId: string | null
      worktreeId?: string
      branchMode?: 'current' | 'separate'
      model?: string
      effort?: EffortLevel
      setupCommand?: string
      runCommand?: string
      initialPrompt?: string
      extraDirs?: string[]
      attachImages?: string[]
    }): Promise<number> => {
      const { claudeMode, codexApproval } = settingsForSection(opts.projectId)
      const termId = await window.api.createTerminal({
        source: opts.source,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        setupCommand: opts.setupCommand,
        runCommand: opts.runCommand,
        permissionMode: claudeMode,
        approvalPolicy: codexApproval,
        model: opts.model,
        effort: opts.effort,
        initialPrompt: opts.initialPrompt,
        extraDirs: opts.extraDirs,
        attachImages: opts.attachImages
      })
      setTabs((t) => [
        ...t,
        {
          termId,
          projectId: opts.projectId,
          source: opts.source,
          mode: 'terminal',
          label: opts.label ?? `${opts.source} (new)`,
          sessionId: opts.sessionId,
          worktreeId: opts.worktreeId,
          branchMode: opts.branchMode,
          model: opts.model,
          effort: opts.effort,
          exited: false
        }
      ])
      setView({ kind: 'terminal', termId })
      return termId
    },
    [settingsForSection]
  )

  /** A plain shell. Agents go through `newAgent` — this is the only pane type
   *  that is a terminal because it *is* a terminal, not because of a CLI.
   *
   *  A shell is where you check the branch by hand — run the tests, read the
   *  build, poke at the thing the agent just wrote — so which checkout it opens
   *  in is the whole question, and it is not answerable from the focus alone:
   *  `git log` wants the branch, `npm install` usually wants main. So unlike ▷,
   *  which follows the focused session silently, `+` *asks* whenever there is
   *  something to ask about, and stays a single click when there isn't. */
  const newShell = useCallback(
    (worktree?: Worktree) =>
      void openTerminal({
        source: 'shell',
        // Selected project → its path; no project → $HOME (main falls back)
        cwd: worktree?.path ?? selectedProject?.path ?? null,
        projectId: selectedProject?.id ?? null,
        worktreeId: worktree?.id,
        label: worktree ? '⎇ zsh' : 'zsh'
      }),
    [openTerminal, selectedProject]
  )

  /**
   * Open an agent as a chat pane instead of a pty. Same session store, same
   * `--resume` ids, so a conversation started in one can be picked up in the
   * other — there is no UI for that swap now, but the ids still line up.
   */
  const openChat = useCallback(
    async (opts: {
      source: 'claude'
      cwd?: string | null
      projectId: string | null
      sessionId?: string
      worktreeId?: string
      branchMode?: 'current' | 'separate'
      model?: string
      effort?: EffortLevel
      label?: string
      setupCommand?: string
      initialPrompt?: string
      initialImages?: string[]
      extraDirs?: string[]
    }): Promise<number> => {
      const { claudeMode } = settingsForSection(opts.projectId)
      const chatId = await window.api.createChat({
        source: opts.source,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        model: opts.model,
        effort: opts.effort,
        permissionMode: claudeMode,
        setupCommand: opts.setupCommand,
        extraDirs: opts.extraDirs
      })
      setTabs((t) => [
        ...t,
        {
          termId: chatId,
          projectId: opts.projectId,
          source: opts.source,
          mode: 'chat',
          label: opts.label ?? opts.source,
          sessionId: opts.sessionId,
          worktreeId: opts.worktreeId,
          branchMode: opts.branchMode,
          model: opts.model,
          effort: opts.effort,
          initialPrompt: opts.initialPrompt,
          initialImages: opts.initialImages,
          resumeSessionId: opts.sessionId,
          exited: false
        }
      ])
      setView({ kind: 'terminal', termId: chatId })
      return chatId
    },
    [settingsForSection]
  )

  /**
   * Open an agent session. This is the one place that decides *how* an agent
   * runs, so every caller — the tab bar, resume, wake, worktrees, card runs —
   * gets the same answer.
   *
   * Claude runs as a chat pane; that is the UI now, and the pty is reached
   * only through a pane's own "Terminal" button (`forceTerminal`), which
   * exists for the things the JSON protocol cannot do: `claude auth`, an
   * interactive `/config`, or a CLI update that breaks the wire format.
   *
   * Codex still runs as a pty because there is no chat backend for it yet —
   * `codex app-server` is the next piece of work, and until it lands this
   * function is the only file that needs to change.
   */
  const openAgent = useCallback(
    (opts: {
      source: Source
      sessionId?: string
      cwd?: string | null
      projectId: string | null
      label?: string
      worktreeId?: string
      branchMode?: 'current' | 'separate'
      model?: string
      effort?: EffortLevel
      setupCommand?: string
      initialPrompt?: string
      /**
       * Images attached to `initialPrompt` that the caller has NOT already
       * accounted for — a paste out of the composer. Translating them is this
       * function's job, because "how does an image reach this agent" is a
       * property of the runtime, which is the one thing it decides.
       *
       * A card run does not use this: `composeCardPrompt` names its assets in
       * the prompt itself (SPEC-TODOS §10.2), so it passes the raw
       * `extraDirs`/`attachImages` below and would be saying it twice.
       */
      images?: string[]
      extraDirs?: string[]
      attachImages?: string[]
      forceTerminal?: boolean
    }): Promise<number> => {
      const images = opts.images ?? []
      if (opts.source === 'claude' && !opts.forceTerminal)
        // A chat pane inlines the bytes as base64 content blocks, so the files
        // need no unlocking and no mention in the prompt
        return openChat({ ...opts, source: 'claude', initialImages: images })

      // The two pty paths, diverging exactly as `promptFlags` describes:
      // claude reads image paths it finds in the prompt, so the staging folder
      // has to be unlocked with --add-dir; codex cannot read one with its file
      // tools at all and takes the files with -i.
      if (images.length === 0) return openTerminal(opts)
      const dirs = [...new Set(images.map((p) => p.slice(0, p.lastIndexOf('/'))))]
      return openTerminal(
        opts.source === 'claude'
          ? {
              ...opts,
              initialPrompt: withImagePaths(opts.initialPrompt ?? '', images),
              extraDirs: [...(opts.extraDirs ?? []), ...dirs]
            }
          : { ...opts, attachImages: [...(opts.attachImages ?? []), ...images] }
      )
    },
    [openChat, openTerminal]
  )


  /**
   * A chat pane learns its conversation id from the CLI's own startup event, so
   * it never goes through the session-store watcher that binds pty panes —
   * but the tab still needs the id for persistence, resume and "open in
   * terminal".
   */
  const bindChatSession = useCallback((termId: number, sessionId: string) => {
    setTabs((t) => t.map((tab) => (tab.termId === termId ? { ...tab, sessionId } : tab)))
  }, [])

  /** Kill whichever runtime backs a pane. */
  const killPane = useCallback((tab: TerminalTab) => {
    if (tab.mode === 'chat') window.api.chatKill(tab.termId)
    else window.api.termKill(tab.termId)
  }, [])

  /**
   * Play button: one shell per non-empty line of the project's start command.
   *
   * Takes the project rather than reading the selected one, because it lives on
   * the sidebar's project row — where it can be pressed for a project that
   * isn't open. The pane it opens belongs to that section, so the section has
   * to come with it, or the new tab lands in a strip nobody is looking at.
   *
   * It runs what you are *looking at*: with an isolated session
   * focused, the dev server comes up in that session's checkout, so pressing ▷
   * is the shortest path from "the agent changed something" to seeing it. The
   * main checkout is the fallback for every other focus (another project, Home,
   * a pane with no branch of its own) — and for a pending session, which has no
   * checkout yet and is only borrowing the shared one.
   *
   * Two things this deliberately does not do. It does not remap ports, so two
   * branches serving the same dev port collide and the second one says so —
   * quieter than silently serving the wrong branch on the port you opened. And
   * the pane is tagged with the worktree, which keeps the branch counted as
   * live: an unattended `npm run dev` will hold a merged worktree back from the
   * reaper, which beats yanking a checkout out from under a running server.
   */
  const runStartCommands = useCallback(
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId)
      if (!project) return
      const worktree =
        activeTab?.projectId === projectId && !activeTab.pending && activeTab.worktreeId
          ? worktrees.find((w) => w.id === activeTab.worktreeId)
          : undefined
      setSelectedProjectId(projectId)
      const lines = (project.runCommand?.trim() || 'npm run dev')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      for (const line of lines) {
        void openTerminal({
          source: 'shell',
          cwd: worktree?.path ?? project.path,
          projectId: project.id,
          worktreeId: worktree?.id,
          // ⎇ marks a branch-bound pane everywhere else in the strip, and two
          // dev servers are otherwise the same word twice
          label: `${worktree ? '⎇ ' : ''}${line.length > 24 ? `${line.slice(0, 24)}…` : line}`,
          runCommand: line
        })
      }
    },
    [openTerminal, projects, worktrees, activeTab]
  )

  const resumeSession = useCallback(
    (s: SessionMeta) => {
      // A session belongs to the section its cwd lives in — Home included.
      // Never inherit the selected project, or a Home session resumed while
      // some project is open would show up as that project's terminal.
      const owner = assignProject(s, projects, worktrees)
      const projectId = owner?.id ?? null
      // A session recorded inside a worktree resumes bound to it — without
      // this the pane runs in the checkout but loses its merge button and the
      // file tree points at the main checkout instead of the branch.
      const wt = worktrees.find((w) => sessionInProject(s.project, w.path))
      setSelectedProjectId(projectId) // follow the terminal to its own section
      void openAgent({
        source: s.source,
        sessionId: s.id,
        cwd: s.project,
        label: wt ? `⎇ ${wt.taskName}` : s.title.slice(0, 30),
        projectId,
        worktreeId: wt?.id
      })
    },
    [openAgent, projects, worktrees]
  )

  /**
   * Clicking a session in the sidebar *is* resuming it — a chat pane opens on
   * its history, so there is no read-only stop along the way.
   *
   * A session that is already running focuses its existing pane instead of
   * starting a second one: two processes appending to one conversation file is
   * how a transcript gets interleaved and a resume picks up the wrong branch.
   * Those rows are dimmed in the sidebar so it is visible before the click.
   */
  const openSession = useCallback(
    (s: SessionMeta) => {
      const tab = tabs.find((t) => t.sessionId === s.id)
      if (tab) {
        setSelectedProjectId(tab.projectId) // may jump sections (e.g. from search)
        setView({ kind: 'terminal', termId: tab.termId })
        return
      }
      resumeSession(s)
    },
    [resumeSession, tabs]
  )

  const wakeDormant = useCallback(
    (t: SavedTerminal) => {
      const wt = t.worktreeId ? worktrees.find((w) => w.id === t.worktreeId) : undefined
      const common = {
        sessionId: t.sessionId,
        cwd: wt?.path ?? selectedProject?.path ?? null,
        label: t.label,
        projectId: selectedProject?.id ?? null,
        worktreeId: wt?.id
      }
      // Sessions saved before chat panes existed have no mode; they wake as
      // chat like everything else. Only an explicit 'terminal' — set by using
      // a pane's Terminal button — keeps a session on the pty.
      void openAgent({ ...common, source: t.source, forceTerminal: t.mode === 'terminal' })
    },
    [openAgent, selectedProject, worktrees]
  )

  /**
   * Open an isolated branch from the sidebar. With no `source` it takes the
   * first thing that exists — a live pane, the terminal we remember, then the
   * newest session recorded inside the checkout — and returns false when the
   * branch has nothing to resume, which is the sidebar's cue to ask for an
   * agent. Every path keeps the worktree binding, so the pane gets its merge
   * button and the file tree follows the branch.
   */
  const openWorktree = useCallback(
    (wt: Worktree, source?: Source): boolean => {
      setSelectedProjectId(wt.projectId)
      // A worktree pane is always an agent — never a shell
      const start = (opts: {
        source: Source
        sessionId?: string
        label: string
        forceTerminal?: boolean
      }): true => {
        void openAgent({ ...opts, cwd: wt.path, projectId: wt.projectId, worktreeId: wt.id })
        return true
      }
      if (source) return start({ source, label: `⎇ ${wt.taskName}` })

      const live = tabs.find((t) => t.worktreeId === wt.id)
      if (live) {
        setView({ kind: 'terminal', termId: live.termId })
        return true
      }
      const project = projects.find((p) => p.id === wt.projectId)
      const saved = project?.terminals.find((t) => t.worktreeId === wt.id)
      if (saved)
        return start({
          source: saved.source,
          sessionId: saved.sessionId,
          label: saved.label,
          forceTerminal: saved.mode === 'terminal'
        })

      const last = sessions
        .filter((s) => sessionInProject(s.project, wt.path))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
      if (last) return start({ source: last.source, sessionId: last.id, label: `⎇ ${wt.taskName}` })
      return false
    },
    [openAgent, projects, sessions, tabs]
  )

  /**
   * `git worktree add -b` plus the record that makes it ours. The one place
   * that mints a `Worktree`, shared by the create modal and by a session that
   * chose a separate branch — so a worktree cut from a first message is
   * indistinguishable from one cut by hand.
   */
  const cutWorktree = useCallback(
    async (
      project: Project,
      taskName: string,
      base?: string
    ): Promise<{ ok: true; worktree: Worktree } | { ok: false; error: string }> => {
      const res = await window.api.createWorktree({
        projectPath: project.path,
        taskName,
        base,
        localFiles: project.worktreeCopy
      })
      if (!res.ok) return { ok: false, error: res.error }
      const worktree: Worktree = {
        id: crypto.randomUUID(),
        projectId: project.id,
        taskName,
        branch: res.branch,
        path: res.path,
        baseBranch: res.baseBranch,
        baseCommit: res.baseCommit,
        createdAt: new Date().toISOString()
      }
      setWorktrees((ws) => [...ws, worktree])
      return { ok: true, worktree }
    },
    []
  )

  /** Create worktree + branch, remember it, launch the agent inside. Error string or null. */
  const createIsolated = useCallback(
    async (taskName: string, agent: Source, setup: string, base: string): Promise<string | null> => {
      const project = selectedProject
      if (!project) return 'Select a project first'
      const cut = await cutWorktree(project, taskName, base)
      if (!cut.ok) return cut.error
      const wt = cut.worktree
      const trimmedSetup = setup.trim()
      if (trimmedSetup !== (project.worktreeSetup ?? '')) {
        setProjects((ps) =>
          ps.map((p) =>
            p.id === project.id ? { ...p, worktreeSetup: trimmedSetup || undefined } : p
          )
        )
      }
      setWtCreateOpen(false)
      void openAgent({
        source: agent,
        cwd: wt.path,
        projectId: project.id,
        label: `⎇ ${taskName}`,
        worktreeId: wt.id,
        setupCommand: trimmedSetup || undefined
      })
      return null
    },
    [selectedProject, openAgent, cutWorktree]
  )

  // ---------- separate-branch sessions ----------

  /** Both catalogs, once. Codex's is a CLI call, so it cannot be imported. */
  useEffect(() => {
    let live = true
    for (const id of AGENT_IDS) {
      void window.api.listAgentModels(id).then((list) => {
        if (live) setModelCatalogs((m) => ({ ...m, [id]: list }))
      })
    }
    return () => {
      live = false
    }
  }, [])

  /**
   * What a pane will actually spawn with. One resolver for the picker's labels
   * and for the spawn arguments, so a session can never run on a model the
   * setup row was not showing.
   */
  const paneChoice = useCallback(
    (agent: AgentId, model?: string, effort?: EffortLevel) => {
      const catalog = modelCatalogs[agent] ?? agentDef(agent).models
      const resolvedModel = sessionModel(agent, model, catalog)
      return {
        catalog,
        model: resolvedModel,
        effort: sessionEffort(agent, effort, catalog.find((m) => m.id === resolvedModel))
      }
    },
    [modelCatalogs]
  )

  /**
   * Swap a pane for a fresh one in the same slot. Used when a session moves
   * checkouts before it has said anything: the old runtime is killed and the
   * new tab takes its place in the strip, so nothing jumps and no second
   * process is ever left driving the same conversation.
   */
  const replacePane = useCallback(
    async (oldTermId: number, opts: Parameters<typeof openAgent>[0]): Promise<void> => {
      const old = tabs.find((t) => t.termId === oldTermId)
      if (old) killPane(old)
      const newTermId = await openAgent(opts)
      setTabs((ts) => {
        const index = ts.findIndex((t) => t.termId === oldTermId)
        const created = ts.find((t) => t.termId === newTermId)
        const rest = ts.filter((t) => t.termId !== oldTermId && t.termId !== newTermId)
        if (index === -1 || !created) return rest.concat(created ?? [])
        rest.splice(Math.min(index, rest.length), 0, created)
        return rest
      })
    },
    [tabs, killPane, openAgent]
  )

  /**
   * The first message of a session — where the setup row's answers are finally
   * acted on, and where the CLI is actually spawned.
   *
   * Everything the row asks about waits for this moment for the same reason:
   * the branch is *named* after the task, and a process started before the
   * agent, model or effort were settled would have to be thrown away and
   * respawned for each change. So an unstarted pane has no process, and this
   * builds the real one.
   *
   * Returning true is a promise to handle the message: the text always
   * survives as the replacement's `initialPrompt`, so there is no path where a
   * typed message is silently dropped. False means "not mine" — a pane already
   * running the agent and checkout it asked for just sends. A worktree that
   * cannot be cut lands the session in the main checkout with the reason in a
   * toast; the work still starts, just not in isolation.
   */
  const startChosenSession = useCallback(
    (tab: TerminalTab, text: string, images: string[]): boolean => {
      const source = tab.source === 'shell' ? 'claude' : tab.source
      // Codex has no chat backend yet (`codex app-server` is the next piece of
      // work), so choosing it means the pane becomes a pty
      const movingRuntime = tab.mode === 'chat' && source !== 'claude'
      const project = projects.find((p) => p.id === tab.projectId) ?? null
      const wantsBranch = tab.branchMode === 'separate' && !tab.worktreeId
      const isolating = wantsBranch && !!project
      const { model, effort } = paneChoice(source, tab.model, tab.effort)

      if (wantsBranch && !project && !tab.pending && !movingRuntime) {
        showToast('Isolated branches need a project — this session is in Home.')
        return false
      }
      // A pending pane has nothing running, so there is always something to do
      if (!tab.pending && !isolating && !movingRuntime) return false

      const inPlace = (): Parameters<typeof openAgent>[0] => ({
        source,
        cwd: project?.path ?? null,
        projectId: project?.id ?? null,
        // The pane has not been named by a conversation yet, so the agent is
        // the only honest label until `bindChatSession` replaces it
        label: source,
        model,
        effort,
        initialPrompt: text,
        images,
        forceTerminal: tab.mode === 'terminal' && !tab.pending
      })

      if (!isolating) {
        void replacePane(tab.termId, inPlace())
        return true
      }

      const owner = project as Project
      setCuttingBranch((s) => new Set(s).add(tab.termId))
      void (async () => {
        try {
          const taken = worktrees
            .filter((w) => w.projectId === owner.id)
            .map((w) => w.taskName)
          // Named from what was *typed*, not from the folded-in paste: with a
          // short sentence the slug's five words would otherwise start eating
          // the wrapper tag ("fix-this-pasted-label-text")
          const taskName = branchNameFor(splitComposed(text).display || text, taken)
          // Undefined is not "no base" — it is the default, which main resolves
          // by fetching and taking whichever of origin/<default> and its local
          // twin is ahead. Only a start point the user named is passed through.
          const cut = await cutWorktree(owner, taskName, tab.baseBranch)
          if (!cut.ok) {
            showToast(`Kept this session in ${owner.name}: ${cut.error}`)
            await replacePane(tab.termId, inPlace())
            return
          }
          await replacePane(tab.termId, {
            source,
            cwd: cut.worktree.path,
            projectId: owner.id,
            label: `⎇ ${taskName}`,
            worktreeId: cut.worktree.id,
            model,
            effort,
            setupCommand: owner.worktreeSetup || undefined,
            initialPrompt: text,
            images,
            forceTerminal: tab.mode === 'terminal' && !tab.pending
          })
        } catch (err) {
          showToast(`Kept this session in ${owner.name}: ${String(err)}`)
          await replacePane(tab.termId, inPlace())
        } finally {
          setCuttingBranch((s) => {
            const next = new Set(s)
            next.delete(tab.termId)
            return next
          })
        }
      })()
      return true
    },
    [projects, worktrees, cutWorktree, replacePane, showToast, paneChoice]
  )


  /** git worktree remove + branch -d, then drop panes/tabs/records. Error string or null. */
  const removeWorktree = useCallback(
    async (wt: Worktree, discard = false): Promise<string | null> => {
      const project = projects.find((p) => p.id === wt.projectId)
      if (!project) return 'Project no longer exists'
      const res = await window.api.worktreeRemove({
        projectPath: project.path,
        worktreePath: wt.path,
        branch: wt.branch,
        discard
      })
      if (!res.ok) return res.error
      const doomedTabs = tabs.filter((t) => t.worktreeId === wt.id)
      const killed = doomedTabs.map((t) => t.termId)
      for (const tab of doomedTabs) killPane(tab)
      setTabs((ts) => ts.filter((t) => t.worktreeId !== wt.id))
      setView((v) => (v.kind === 'terminal' && killed.includes(v.termId) ? { kind: 'empty' } : v))
      setWorktrees((ws) => ws.filter((w) => w.id !== wt.id))
      setProjects((ps) =>
        ps.map((p) => ({ ...p, terminals: p.terminals.filter((t) => t.worktreeId !== wt.id) }))
      )
      setShipReview(null)
      if (!res.branchDeleted && res.note) showToast(res.note)
      return null
    },
    [projects, tabs, showToast]
  )

  /**
   * Is this project's own checkout standing on work that already landed?
   *
   * Read on selection and after a ship rather than polled: it is two local git
   * spawns, but the answer only moves when somebody switches a branch or a PR
   * merges, and the row it feeds is inside the expanded section anyway.
   */
  const loadStaleCheckout = useCallback((project: Project) => {
    void window.api.gitStaleCheckout(project.path).then((stale) =>
      setStaleCheckouts((m) => {
        const had = m.get(project.id)
        if (had?.branch === stale?.branch && had?.target === stale?.target) return m
        const next = new Map(m)
        if (stale) next.set(project.id, stale)
        else next.delete(project.id)
        return next
      })
    )
  }, [])

  /**
   * Put the project's own checkout back on its default branch, if it is
   * sitting on work that already landed.
   *
   * Runs when a session is created, which is the one moment the branch it is
   * standing on is provably finished with — Ship deliberately leaves HEAD on
   * the branch it cut so a follow-up ship adds to the same PR, and this is
   * where that gets cleaned up.
   *
   * Two conditions make it safe to do without asking, both re-read here rather
   * than taken from the sidebar's cached reading (a photograph of whenever the
   * project was last selected): the branch must be **merged** into
   * `origin/<default>`, and the tree must be **clean**. If either fails it
   * declines and the sidebar row offers the switch by hand instead.
   *
   * Deliberately **not** guarded on live panes, unlike `reapMerged`. That rule
   * exists because removing a worktree deletes files under a running agent —
   * here the opposite is true: any pane open in this checkout is standing on
   * the same finished branch, so moving it to the default branch is the favour,
   * and the clean-tree check has already ruled out losing anyone's work. With
   * `branchMode: 'current'` the default, a live-pane guard would also mean this
   * almost never fires, since the shared checkout is where sessions normally
   * are.
   */
  const tidyCheckout = useCallback(
    async (project: Project) => {
      const stale = await window.api.gitStaleCheckout(project.path)
      if (!stale) return
      const res = await window.api.gitSwitchBranch(project.path, stale.target)
      // Said out loud either way: a branch moving under you is not something to
      // discover later, and a refusal is why the session did not start on main
      showToast(
        res.ok
          ? `${project.name} was on ${stale.branch} (already merged) — now on ${stale.target}.`
          : `Kept ${project.name} on ${stale.branch}: ${res.error}`
      )
      loadStaleCheckout(project)
    },
    [showToast, loadStaleCheckout]
  )

  /**
   * Open an **unstarted** agent session in a section: a pane with a composer
   * and nothing behind it yet. The sidebar's "New session" button is the only
   * way in — selecting a project navigates, it does not create.
   *
   * Nothing is decided at this point except the section. The agent and the
   * checkout are chosen in the pane's own setup row and read back off the tab
   * when the first message arrives, because both questions are only really
   * answerable once you know the task — and the branch is *named* after it.
   *
   * Starts in the project's own checkout, not a worktree. Most sessions are a
   * question or a small edit on the branch already open, and cutting a branch
   * for one is a folder to clean up afterwards. The setup row's toggle is the
   * way *into* isolation, and it is worth reaching for whenever a session will
   * be shipped: Ship stages the whole tree (`git add -A`), so two agents in
   * one checkout means one of them sweeps the other's work into its PR.
   */
  const newAgent = useCallback(
    (project: Project | null) => {
      void (async () => {
        // Starting new work is the one moment the old work is provably
        // finished, so it is where the checkout gets tidied — not at ship
        // time, which would make a follow-up ship open a second PR.
        if (project) await tidyCheckout(project)
        // A tab with no process behind it, so the id comes from main's counter
        // rather than from a spawn. Nothing here is committed to yet: agent,
        // model, effort and checkout are all still the setup row's to change,
        // and spawning now would mean re-spawning on every one of them.
        const termId = await window.api.reservePaneId()
        setTabs((t) => [
          ...t,
          {
            termId,
            projectId: project?.id ?? null,
            // Claude only as the row's starting position — picking Codex before
            // the first message opens a pty instead
            source: 'claude',
            mode: 'chat',
            // Not the agent's name: which agent is still a choice, and the
            // conversation's own title replaces this on the first turn
            label: 'New session',
            branchMode: 'current',
            pending: true,
            exited: false
          }
        ])
        setView({ kind: 'terminal', termId })
      })()
    },
    [tidyCheckout]
  )

  /**
   * Refresh a project's remote-tracking refs when it is selected.
   *
   * A session is a worktree cut from `origin/<default>`, so "new sessions
   * start on current main" is a fetch and nothing more — no ref that a
   * checkout, a dev server or a running agent is standing on moves, which is
   * what makes it safe to do without asking. Throttled per project because
   * clicking between two projects should not be a network call each way, and
   * fire-and-forget because nothing on screen is waiting for it.
   */
  const fetchedAt = useRef(new Map<string, number>())

  /**
   * The branches a session can be cut from, for the setup row's picker.
   *
   * One `for-each-ref` and no network, so it is re-read whenever a project is
   * selected — a branch created in a terminal a minute ago has to be offerable
   * without restarting the app. `asked` only guards the on-demand path below,
   * where a repeat read would buy nothing.
   */
  const askedBranches = useRef(new Set<string>())
  const loadBranches = useCallback((path: string, force = false) => {
    if (!force && askedBranches.current.has(path)) return
    askedBranches.current.add(path)
    void window.api.worktreeBranches(path).then((res) => {
      // A repo git cannot read is not an error to surface here: the picker
      // falls back to the default row, which is what it would have used anyway
      if (!res.ok) return
      setBranchLists((m) =>
        new Map(m).set(path, { current: res.current, local: res.local, remote: res.remote })
      )
    })
  }, [])

  const prefetchProject = useCallback(
    (project: Project) => {
      // `origin/main` names the base an isolated session will be cut from. Read
      // from the local symref, so it costs nothing and is worth keeping current.
      void window.api.gitDefaultBase(project.path).then((base) =>
        setDefaultBases((m) =>
          m.get(project.path) === base ? m : new Map(m).set(project.path, base)
        )
      )
      loadBranches(project.path, true)
      loadStaleCheckout(project)
      const last = fetchedAt.current.get(project.path) ?? 0
      if (Date.now() - last < 5 * 60_000) return
      fetchedAt.current.set(project.path, Date.now())
      void window.api.gitFetch(project.path)
    },
    [loadBranches, loadStaleCheckout]
  )

  // A pending pane can belong to a project that is not the selected one, and
  // its setup row offers the same picker — so the list is fetched for whatever
  // project actually has one open, not only for whatever is on screen.
  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.pending) continue
      const project = projects.find((p) => p.id === tab.projectId)
      if (project) loadBranches(project.path)
    }
  }, [tabs, projects, loadBranches])

  /**
   * Select a project (or Home) in the sidebar.
   *
   * Selecting is only ever navigation: it focuses the section's last pane, or
   * lands on the empty state when there is none. Creating a session is "New
   * session" and nothing else — clicking through projects to read a file tree
   * or a diff should not leave a trail of panes behind it.
   */
  const selectSection = useCallback(
    (id: string | null) => {
      setSelectedProjectId(id)
      const project = projects.find((p) => p.id === id) ?? null
      // Every selection, not only the ones that open a pane: whatever you do
      // next in this project starts from the refs this brings in
      if (project) prefetchProject(project)
      const sectionTabs = tabs.filter((t) => t.projectId === id)
      if (sectionTabs.length === 0) {
        setView({ kind: 'empty' })
        return
      }
      const remembered = lastViewedTerm.current.get(id)
      const target = sectionTabs.find((t) => t.termId === remembered) ?? sectionTabs[sectionTabs.length - 1]
      setView({ kind: 'terminal', termId: target.termId })
    },
    [tabs, projects, prefetchProject]
  )

  /**
   * The agent and the checkout a pane will use, changed from its setup row
   * until the first message settles both. Held on the tab rather than inside
   * the pane so the tab strip's badge and the branch chip read the same
   * answer the send path will act on.
   */
  const setPaneChoice = useCallback(
    (
      termId: number,
      next: {
        source?: Source
        branchMode?: 'current' | 'separate'
        /** `''` picks the default back — the one answer that is stored as absent */
        base?: string
        model?: string
        effort?: EffortLevel
      }
    ) => {
      // Only the keys actually present: the row sends one answer at a time, and
      // spreading the rest as `undefined` would wipe the others
      const patch: Partial<TerminalTab> = {}
      if (next.source !== undefined) patch.source = next.source
      if (next.branchMode !== undefined) patch.branchMode = next.branchMode
      if (next.model !== undefined) patch.model = next.model
      if (next.effort !== undefined) patch.effort = next.effort
      // The one answer whose absence is meaningful: the picker's default row
      // has no ref of its own, so choosing it clears the field rather than
      // writing today's `origin/main` onto the tab.
      if (next.base !== undefined) patch.baseBranch = next.base || undefined
      setTabs((ts) =>
        ts.map((t) => {
          if (t.termId !== termId) return t
          // A model id belongs to one CLI's catalog, and the effort set is per
          // model — switching agents drops both rather than carrying a flag
          // the new CLI would reject at spawn
          if (next.source && next.source !== t.source)
            return { ...t, ...patch, model: undefined, effort: undefined }
          return { ...t, ...patch }
        })
      )
    },
    []
  )

  /**
   * Remove worktrees whose PR has landed. Isolation being the default means a
   * checkout per session, so without this they only ever accumulate — and the
   * moment a PR merges is the one moment the branch is provably finished.
   *
   * Three things keep it from being a footgun. (1) It only ever calls the same
   * unforced `removeWorktree` the button calls, so **git refuses** anything
   * with uncommitted or unmerged work — the safety is git's, not a check here.
   * (2) A worktree with a live pane is never touched: removal kills panes, and
   * a checkout disappearing from under a running agent is far worse than an
   * extra folder. (3) `gitMergedBranches` returns nothing when gh is
   * unreachable, so a network failure reaps nothing rather than everything.
   */
  const reapSeq = useRef(0)
  const reapedAt = useRef(0)
  const reapMerged = useCallback(async () => {
    // One network call per project per window focus would be a tax on focusing
    // the window; the branches this watches move on the scale of hours
    if (Date.now() - reapedAt.current < 5 * 60_000) return
    const live = new Set(tabs.map((t) => t.worktreeId).filter(Boolean))
    const byProject = new Map<string, Worktree[]>()
    for (const w of worktrees) {
      if (live.has(w.id) || !w.branch) continue
      byProject.set(w.projectId, [...(byProject.get(w.projectId) ?? []), w])
    }
    // Stamped only once there is something to ask about, and `loaded` is the
    // honest signal for that: projects and worktrees arrive in the same read,
    // so before it an empty list means "not read yet" and would spend the
    // window, while after it an empty list is a real answer. Gating on the
    // worktree records instead — as this did — skipped the whole pass for a
    // project whose records had drifted away, which is exactly the project
    // with orphaned branches to prune.
    if (!loaded.current || projects.length === 0) return
    reapedAt.current = Date.now()
    const seq = ++reapSeq.current

    // Which projects are worth a network call, decided locally first. This
    // pass asks every project rather than only the ones holding records — a
    // project whose records drifted away is precisely the one with orphans —
    // and a `gh pr list` each on every window focus would be a real tax on a
    // sidebar of a dozen repos you mostly aren't looking at. A repo with no
    // record *and* nothing locally prunable never reaches the network.
    const scoped = await Promise.all(
      projects.map(async (p) => ({
        project: p,
        records: byProject.get(p.id) ?? [],
        orphans: await window.api.worktreePruneCandidates(p.path)
      }))
    )
    if (seq !== reapSeq.current) return

    const answers = await Promise.all(
      scoped
        .filter((s) => s.records.length || s.orphans.length)
        .map(async (s) => [s, await window.api.gitMergedBranches(s.project.path)] as const)
    )
    if (seq !== reapSeq.current) return

    const reaped: string[] = []
    const pruned: string[] = []
    for (const [{ project, orphans }, mergedNames] of answers) {
      // Empty is also what an unreachable gh returns, and both mean don't reap
      if (!mergedNames.length) continue
      const merged = new Set(mergedNames)
      for (const wt of byProject.get(project.id) ?? []) {
        if (!merged.has(wt.branch)) continue
        // git's refusal is the guard; a kept worktree is not worth a toast
        if ((await removeWorktree(wt)) === null) reaped.push(wt.taskName)
        if (seq !== reapSeq.current) return
      }
      // The branches the pass above structurally cannot see — merged, but with
      // no record left to find them by. Narrowed to the local candidates so a
      // project whose orphans are all live work costs nothing here; main
      // re-checks every name itself and deletes with `-d` regardless, so this
      // is a filter for cost, never the safety.
      const stale = orphans.filter((b) => merged.has(b))
      if (stale.length)
        pruned.push(...(await window.api.worktreePruneBranches(project.path, stale)))
      if (seq !== reapSeq.current) return
    }

    const total = reaped.length + pruned.length
    if (total)
      showToast(
        `Cleaned up ${total} merged ${total === 1 ? 'branch' : 'branches'}: ${[...reaped, ...pruned].join(', ')}`
      )
  }, [worktrees, projects, tabs, removeWorktree, showToast])

  useEffect(() => {
    void reapMerged()
    const onFocus = (): void => void reapMerged()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      reapSeq.current++
    }
  }, [reapMerged])

  /**
   * The sidebar's remove, on any branch — spent or still live.
   *
   * Abandoning a task you don't want to finish is a normal thing to do, so the
   * button is not reserved for branches git considers safe to delete. What
   * makes it safe is that the dialog names the loss before it happens: the
   * row's polled `WorktreeState` says how many uncommitted files and how many
   * commits go with it, and `discard` (the only `--force`/`-D` in the app) is
   * passed only when there is something to discard and the person said yes to
   * that sentence.
   *
   * The escalation exists because that state is polled, not live: an agent can
   * write a file between the last poll and the click, and git then refuses a
   * removal the dialog promised. Rather than leave a dead button, the refusal
   * is re-asked as the discard question it should have been.
   */
  /**
   * Throw one file's changes away, after saying exactly what goes.
   *
   * There is no undo and there is no reflog for a working tree, so the
   * confirmation is the entire safety mechanism — the same standing rule as
   * abandoning a worktree: forcing is allowed, but only after a person was
   * shown the loss. It names the line counts rather than saying "changes",
   * because "discard 4 lines" and "discard 900 lines" deserve different
   * amounts of hesitation and the panel already knows which this is.
   *
   * Nothing warns about an agent working in the same checkout. It would fire on
   * nearly every discard here — the panel is usually open *because* an agent
   * just wrote these files — so it would be noise, and the diff the row opens
   * is the honest way to check before throwing it away.
   */
  const confirmDiscard = useCallback(
    (file: ChangedFile, count?: number) => {
      const untracked = file.status === '?'
      const lines = [
        file.additions ? `${file.additions} added` : '',
        file.deletions ? `${file.deletions} deleted` : ''
      ].filter(Boolean)

      const question = file.isDir
        ? `Delete the ${file.path} folder${count ? ` and the ${count} file${count === 1 ? '' : 's'} in it` : ''}?` +
          '\n\nNone of it has ever been committed, so this cannot be undone.'
        : untracked
          ? `Delete ${file.path}?\n\nIt has never been committed, so this cannot be undone.`
          : `Discard changes to ${file.path}?` +
            (lines.length ? `\n\n${lines.join(', ')} — ` : '\n\n') +
            'this cannot be undone.'
      if (!window.confirm(question)) return

      void window.api.gitDiscard({ root: treeRoot, paths: [file.path] }).then((res) => {
        if (!res.ok) {
          showToast(res.error ?? 'Could not discard')
          return
        }
        // Nothing was thrown away because git no longer saw a change there —
        // an agent had already reverted it, or it was committed a moment ago.
        // Silence would read as a button that did nothing.
        if (res.discarded.length === 0) {
          showToast(`${file.path} has no changes to discard any more.`)
          return
        }
        // The diff layer is showing a file that no longer differs from HEAD
        setGitSel((sel) => (sel?.kind === 'file' && sel.file.path === file.path ? null : sel))
      })
      // The status refresh is the fs watcher's — `useGitStatus` re-reads on
      // every working-tree change, and a discard is one
    },
    [treeRoot, showToast]
  )

  const confirmRemoveWorktree = useCallback(
    (wt: Worktree, state: WorktreeState | null) => {
      const what = wt.branch ? `and delete branch ${wt.branch}` : '(it has no branch)'
      // Removal kills every pane running in the checkout — say so before it happens
      const open = tabs.filter((t) => t.worktreeId === wt.id).length
      const alsoCloses = open
        ? `\n\nThis closes ${open} open terminal${open === 1 ? '' : 's'} running there.`
        : ''

      const dirty = state?.dirty ?? 0
      const ahead = state?.ahead ?? 0
      const losses = [
        dirty ? `${dirty} uncommitted file${dirty === 1 ? '' : 's'}` : '',
        ahead ? `${ahead} commit${ahead === 1 ? '' : 's'} not on ${wt.baseBranch || 'main'}` : ''
      ].filter(Boolean)
      const discard = losses.length > 0

      const question = discard
        ? `Delete the ${wt.taskName} branch and throw away ${losses.join(' and ')}?` +
          `\n\nThis cannot be undone${ahead ? ' — unless those commits were already pushed' : ''}.` +
          alsoCloses
        : `Remove the ${wt.taskName} worktree ${what}?${alsoCloses}`
      if (!window.confirm(question)) return

      void removeWorktree(wt, discard).then((err) => {
        if (!err) return
        if (discard) return showToast(err)
        // The clean-looking checkout wasn't. Ask the real question rather than
        // toasting a refusal at someone who already asked for this branch gone.
        if (!window.confirm(`git refused: ${err}\n\nDelete it anyway, discarding that work?`)) return
        void removeWorktree(wt, true).then((e) => {
          if (e) showToast(e)
        })
      })
    },
    [removeWorktree, showToast, tabs]
  )

  /** The escape hatch for a squash/rebase merge, which git can't recognise. */
  const setWorktreeDone = useCallback((wt: Worktree, done: boolean) => {
    setWorktrees((ws) =>
      ws.map((w) =>
        w.id === wt.id ? { ...w, doneAt: done ? new Date().toISOString() : undefined } : w
      )
    )
  }, [])

  /**
   * A shipped branch is finished work as far as the sidebar is concerned —
   * the commits are on a PR, not sitting in a checkout waiting to be merged.
   * Optimistic on purpose (the PR isn't merged yet); the row's Reopen undoes it.
   */
  const onShipped = useCallback(
    (res: ShipSuccess, shipped?: Worktree) => {
      // Ship may have renamed the branch on the way out. The record is what the
      // sidebar polls state with and what the merged-PR reaper matches on, so a
      // stale name here leaves the row reporting on a branch that no longer
      // exists. The folder keeps its task name — it lives under ~/.chewo and
      // nothing reads it as the branch.
      if (shipped && res.branch !== shipped.branch)
        setWorktrees((ws) =>
          ws.map((w) => (w.id === shipped.id ? { ...w, branch: res.branch } : w))
        )
      // Either route ends the session's work — the direct push especially, since
      // no PR will ever exist for `reapMerged` to notice. Marking it done is what
      // puts the row in the state whose trash button is the way out.
      if (shipped) setWorktreeDone(shipped, true)
      // Ship is the one thing in the app that moves HEAD in a shared checkout,
      // so the sidebar's reading of it is stale the moment this returns
      const owner = projects.find((p) => p.id === (shipped?.projectId ?? selectedProjectId))
      if (owner) loadStaleCheckout(owner)
      const cut = res.branchedFrom ? `, cut from ${res.branchedFrom}` : ''
      const what =
        res.route === 'push'
          ? `Pushed onto ${res.base}${cut}.`
          : `${res.created ? 'PR opened' : 'Pushed to the open PR'}: ${res.branch} → ${res.base}${cut}.`
      // The push route has a PR only when the base already had one open; with
      // no url there is nothing for the action to open
      showToast(
        what,
        res.url
          ? { label: 'Open PR', onClick: () => void window.api.openExternal(res.url) }
          : undefined
      )
    },
    [setWorktreeDone, showToast, projects, selectedProjectId, loadStaleCheckout]
  )

  /**
   * Put a project's checkout back on its default branch.
   *
   * Offered, never assumed: `staleCheckout` refused to report a dirty checkout,
   * but that was a photograph — several agents write this checkout, so the
   * click can land after one of them has. A plain `git switch` is the guard;
   * git's refusal is shown verbatim and nothing escalates to carry work across.
   */
  const switchCheckout = useCallback(
    async (project: Project, to: StaleCheckout) => {
      const res = await window.api.gitSwitchBranch(project.path, to.target)
      showToast(res.ok ? `${project.name} is on ${to.target}.` : res.error)
      loadStaleCheckout(project)
    },
    [showToast, loadStaleCheckout]
  )

  /** Read the change, then open the review on it. Errors never open a dialog. */
  const openShip = useCallback(
    async (root: string) => {
      setShipReading(root)
      // The PR goes back where the branch was cut from. `baseBranch` is the
      // start point recorded at cut time, handed over as git wrote it —
      // main strips the remote and falls back to the repo default if that ref
      // was never pushed. Without it every session PR'd into the repo default,
      // so work started on an integration branch quietly targeted `main`.
      const base = worktrees.find((w) => w.path === root)?.baseBranch
      const res = await window.api.gitShipPreview({ root, ...(base && { base }) })
      setShipReading(null)
      if (!res.ok) {
        showToast(res.error)
        return
      }
      setShipReview({ root, preview: res })
    },
    [showToast, worktrees]
  )

  /** Which checkout the open Ship review belongs to — a worktree, or the project */
  const shipRoot = shipReview?.root ?? null
  const shipWorktree = shipRoot ? worktrees.find((w) => w.path === shipRoot) : undefined
  const shipProject = shipRoot
    ? (projects.find((p) => p.id === shipWorktree?.projectId) ??
      projects.find((p) => p.path === shipRoot))
    : undefined

  const closeTerminal = useCallback(
    (termId: number) => {
      const closing = tabs.find((tab) => tab.termId === termId)
      if (closing) killPane(closing)
      setTabs((t) => t.filter((tab) => tab.termId !== termId))
      // Closing a tab forgets the session for good — otherwise it would be
      // re-persisted as a resumable dormant tab and reappear on the next load.
      if (closing?.sessionId) {
        const sid = closing.sessionId
        if (closing.projectId === null) {
          setHomeTerminals((ts) => ts.filter((t) => t.sessionId !== sid))
        } else {
          setProjects((ps) =>
            ps.map((p) =>
              p.id === closing.projectId
                ? { ...p, terminals: p.terminals.filter((t) => t.sessionId !== sid) }
                : p
            )
          )
        }
      }
      // Closing the focused tab hands focus to its left neighbour in the same
      // section (falling back to the right, then the empty state). Closing a
      // background tab leaves focus where it is.
      setView((v) => {
        if (v.kind !== 'terminal' || v.termId !== termId || !closing) return v
        const siblings = tabs.filter((tab) => tab.projectId === closing.projectId)
        const idx = siblings.findIndex((tab) => tab.termId === termId)
        const neighbour = siblings[idx - 1] ?? siblings[idx + 1] ?? null
        return neighbour ? { kind: 'terminal', termId: neighbour.termId } : { kind: 'empty' }
      })
    },
    [tabs]
  )

  const removeDormant = useCallback(
    (sessionId: string) => {
      if (selectedProject) {
        setProjects((ps) =>
          ps.map((p) =>
            p.id === selectedProject.id
              ? { ...p, terminals: p.terminals.filter((t) => t.sessionId !== sessionId) }
              : p
          )
        )
      } else {
        setHomeTerminals((ts) => ts.filter((t) => t.sessionId !== sessionId))
      }
    },
    [selectedProject]
  )

  const saveSectionSettings = useCallback(
    (id: string | null, settings: AgentSettings, project?: ProjectSettings) => {
      if (id === null) {
        setHomeSettings(settings)
        return
      }
      // `project` always carries every key for a project, so a cleared field
      // spreads its `undefined` over the old value rather than keeping it
      setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, ...settings, ...project } : p)))
    },
    []
  )

  // ---------- notes workflow ----------

  const currentTopic = notesSel
    ? (notesTree?.subjects
        .find((s) => s.name === notesSel.subject)
        ?.topics.find((t) => t.name === notesSel.topic) ?? null)
    : null

  // Rescans can remove the selection (folder renamed/deleted in Finder)
  useEffect(() => {
    if (!notesTree) return
    if (notesSel && !currentTopic) {
      setNotesSel(null)
      setSelectedNotePath(null)
      return
    }
    if (
      selectedNotePath &&
      currentTopic &&
      !currentTopic.notes.some((n) => n.path === selectedNotePath)
    )
      setSelectedNotePath(null)
  }, [notesTree, notesSel, currentTopic, selectedNotePath])

  const createSubject = useCallback(
    async (name: string): Promise<string | null> => {
      const res = await window.api.notesCreateSubject(name)
      if (res.ok) void refreshNotes()
      return res.ok ? null : (res.error ?? 'Could not create subject')
    },
    [refreshNotes]
  )

  const createTopic = useCallback(
    async (subject: string, name: string): Promise<string | null> => {
      const res = await window.api.notesCreateTopic(subject, name)
      if (res.ok) void refreshNotes()
      return res.ok ? null : (res.error ?? 'Could not create topic')
    },
    [refreshNotes]
  )

  const selectTopic = useCallback((ref: TopicRef) => {
    setNotesSel(ref)
    setSelectedNotePath(null)
  }, [])

  const createNote = useCallback(
    async (title: string, body?: string, source?: NoteSource) => {
      if (!notesSel) return
      const res = await window.api.notesCreateNote({
        subject: notesSel.subject,
        topic: notesSel.topic,
        title,
        body,
        source
      })
      if (res.ok && res.path) {
        setSelectedNotePath(res.path)
        void refreshNotes()
      } else if (!res.ok) {
        showToast(res.error ?? 'Could not create note')
      }
    },
    [notesSel, refreshNotes, showToast]
  )

  // Is there a key to send audio to, and did anything survive a dropped
  // stream? One call answers both — it is what ungreys every dictation
  // control and what fills the Voice pane's recovery list.
  const refreshSttStatus = useCallback(async () => {
    const status = await window.api.sttStatus()
    setSttReady(status.hasKey)
    setSttPending(status.pendingRecoveries)
  }, [])

  refreshSttStatusRef.current = refreshSttStatus

  useEffect(() => {
    void refreshSttStatus()
  }, [refreshSttStatus])

  const startRecording = useCallback(
    (source: SttSource = 'mic', style: NoteStyle = 'lecture') => {
      if (!notesSel || !selectedNotePath || recordingRef.current) return
      if (!sttReady) {
        showToast('No Deepgram API key yet — add one in Settings → Voice.')
        return
      }
      setRecording({ phase: 'connecting', ref: notesSel, notePath: selectedNotePath, source, style })
      // The lesson and style travel with the audio so a stream that dies can
      // still be recovered into the right note later.
      window.api.sttStart(source, selectedNotePath, style)
    },
    [notesSel, selectedNotePath, sttReady, showToast]
  )

  /**
   * Re-transcribes a recording whose live stream died, then puts it through
   * the same structure-and-append path a normal dictation takes.
   */
  const recoverRecording = useCallback(
    async (id: string) => {
      const result = await window.api.sttRecover(id)
      if (!result.ok || !result.transcript) {
        showToast(result.error ?? 'Nothing could be transcribed from that recording.')
        await refreshSttStatus()
        return
      }
      const lessonPath = result.meta?.lessonPath
      if (!lessonPath) {
        // A to-do voice command has no lesson to land in; the words are of no
        // use hours later, so recovering it just clears the entry.
        showToast('Recovered a voice command — nothing to append it to.')
      } else {
        await appendTranscript(
          lessonPath,
          result.transcript,
          result.durationS ?? 0,
          result.meta?.style ?? 'lecture',
          'Recovered'
        )
      }
      await window.api.sttDiscardRecording(id)
      await refreshSttStatus()
    },
    [appendTranscript, refreshSttStatus, showToast]
  )

  const discardRecording = useCallback(
    async (id: string) => {
      await window.api.sttDiscardRecording(id)
      await refreshSttStatus()
    },
    [refreshSttStatus]
  )

  const stopRecording = useCallback(() => {
    window.api.sttStop()
  }, [])

  /** Notes, and whole subject/topic folders — all go to the Trash. */
  const deleteNotesItem = useCallback(
    async (path: string) => {
      const res = await window.api.notesDelete(path)
      if (!res.ok) showToast(res.error ?? 'Could not move to Trash')
      setSelectedNotePath((p) => (p && isAtOrUnder(p, path) ? null : p))
      void refreshNotes()
    },
    [refreshNotes, showToast]
  )

  /**
   * Rename a subject or topic folder. Names are the selection key, so the
   * selection and any open lesson are re-pointed before the rescan lands —
   * otherwise the tree effect above reads them as deleted and clears them.
   */
  const renameNotesItem = useCallback(
    async (path: string, newName: string): Promise<string | null> => {
      const subject = notesTree?.subjects.find((s) => s.path === path)
      const topic = notesTree?.subjects
        .flatMap((s) => s.topics.map((t) => ({ subject: s.name, topic: t })))
        .find((x) => x.topic.path === path)
      const res = await window.api.notesRename(path, newName)
      if (!res.ok || !res.path) return res.error ?? 'Could not rename'
      const name = newName.trim()
      // One batch: tree and selection must never render out of step
      setNotesTree(await window.api.notesScan())
      setNotesSel((sel) => {
        if (!sel) return sel
        if (subject && sel.subject === subject.name) return { subject: name, topic: sel.topic }
        if (topic && sel.subject === topic.subject && sel.topic === topic.topic.name)
          return { subject: sel.subject, topic: name }
        return sel
      })
      setSelectedNotePath((p) =>
        p && isAtOrUnder(p, path) ? res.path + p.slice(path.length) : p
      )
      return null
    },
    [notesTree]
  )

  // ---------- todo workflow ----------

  // A deleted project's scope falls back to General (board files are kept on
  // disk — cheap, revisit in T4)
  const todoProject = todoScopeId ? (projects.find((p) => p.id === todoScopeId) ?? null) : null
  const todoScopeDir = todoProject
    ? projectScopeDir(todoProject.name, todoProject.path)
    : GENERAL_SCOPE
  const todoScopeDirRef = useRef(todoScopeDir)
  todoScopeDirRef.current = todoScopeDir

  useEffect(() => {
    if (workflow !== 'todo') return
    let alive = true
    void window.api.todosBoard(todoScopeDir).then((b) => {
      if (alive) setTodoBoard(b)
    })
    return () => {
      alive = false
    }
  }, [workflow, todoScopeDir])

  // Voice commands (T2) and MCP tools (T3) mutate from main — pushed state
  // is the source of truth, so re-fetch when the visible board changes
  useEffect(
    () =>
      window.api.onTodosChanged(({ scopeDir }) => {
        if (scopeDir !== todoScopeDirRef.current) return
        void window.api.todosBoard(scopeDir).then(setTodoBoard)
      }),
    []
  )

  const addTodoCard = useCallback(
    (title: string, status: TodoStatus) =>
      void window.api.todosAddCard({ scopeDir: todoScopeDir, title, status }).then(setTodoBoard),
    [todoScopeDir]
  )
  const moveTodoCard = useCallback(
    (cardId: string, to: TodoStatus) =>
      void window.api.todosMoveCard({ scopeDir: todoScopeDir, cardId, to }).then(setTodoBoard),
    [todoScopeDir]
  )
  const updateTodoCard = useCallback(
    async (args: UpdateCardPayload) =>
      setTodoBoard(await window.api.todosUpdateCard({ scopeDir: todoScopeDir, ...args })),
    [todoScopeDir]
  )
  const deleteTodoCard = useCallback(
    (cardId: string) =>
      void window.api.todosDeleteCard({ scopeDir: todoScopeDir, cardId }).then(setTodoBoard),
    [todoScopeDir]
  )
  const archiveTodoDone = useCallback(
    () => void window.api.todosArchiveDone(todoScopeDir).then(setTodoBoard),
    [todoScopeDir]
  )

  /**
   * The run button in the card modal (SPEC-TODOS §10): launches an
   * interactive session on the chosen agent with the card's content as the
   * submitted prompt. Deliberately does NOT switch to the code workflow — you
   * stay on the board to keep filing cards, and a toast says where it went.
   * The card ↔ terminal link is renderer-only and dies with the app (§10.1).
   */
  const [cardRuns, setCardRuns] = useState<Map<string, number>>(new Map())
  const runTodoCard = useCallback(
    async (cardId: string, agent: Source) => {
      // The pick sticks for the next card too — it's a habit, not a per-card
      // property, so it lives in the workspace file rather than on the card
      setTodoRunAgent(agent)
      // Re-read rather than trusting a card object from before the modal's
      // save — the prompt must be the text the user just looked at
      const [board, assetsDir] = await Promise.all([
        window.api.todosBoard(todoScopeDir),
        window.api.todosAssetsDir(todoScopeDir)
      ])
      const card = board.cards[cardId]
      if (!card) return
      const termId = await openAgent({
        source: agent,
        // General runs in Home, like Home-section sessions
        cwd: todoProject?.path ?? null,
        projectId: todoProject?.id ?? null,
        label: card.title.length > 30 ? `${card.title.slice(0, 30)}…` : card.title,
        initialPrompt: composeCardPrompt(card, assetsDir),
        // The assets folder is outside the cwd — without this Claude's first
        // Read of a pasted image hits a permission prompt. Codex can't read an
        // image with its file tools at all, so it gets the files attached.
        extraDirs: card.images?.length ? [assetsDir] : undefined,
        attachImages: card.images?.map((name) => `${assetsDir}/${name}`)
      })
      setCardRuns((prev) => new Map(prev).set(cardId, termId))
      setTodoBoard(await window.api.todosMarkRun({ scopeDir: todoScopeDir, cardId }))
      showToast(
        `Running “${card.title}” in ${agentDef(agent).label} — ${todoProject?.name ?? 'Home'}. It's in the Code tabs when you want it.`
      )
    },
    [openAgent, showToast, todoProject, todoScopeDir]
  )

  // A card's badge must not outlive its terminal
  const liveTermIds = useMemo(() => new Set(tabs.map((t) => t.termId)), [tabs])
  const focusCardRun = useCallback((termId: number) => {
    setWorkflow('code')
    setView({ kind: 'terminal', termId })
  }, [])

  const createProject = useCallback(async () => {
    const path = await window.api.pickFolder()
    if (!path) return
    const name = path.split('/').pop() ?? path
    const project: Project = { id: crypto.randomUUID(), name, path, terminals: [] }
    setProjects((ps) => [...ps, project])
    setSelectedProjectId(project.id)
  }, [])

  const deleteProject = useCallback(
    (id: string, deleteBoard = false, project?: { name: string; path: string }) => {
      // Board files outlive the project entry unless the user opted in at the
      // confirm — the folder may come back (SPEC-TODOS §8)
      if (deleteBoard && project) {
        void window.api.todosDeleteScope(projectScopeDir(project.name, project.path))
      }
      // Closing a project fully tears it down: kill its live terminals and drop
      // their tabs, rather than orphaning them into Home.
      const doomed = tabs.filter((tab) => tab.projectId === id)
      for (const tab of doomed) killPane(tab)
      const doomedIds = new Set(doomed.map((tab) => tab.termId))
      setTabs((t) => t.filter((tab) => !doomedIds.has(tab.termId)))
      setProjects((ps) => ps.filter((p) => p.id !== id))
      setFilesBySection((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      if (selectedProjectId === id) setSelectedProjectId(null)
      // If the focused terminal belonged to the closed project, drop the view.
      setView((v) => (v.kind === 'terminal' && doomedIds.has(v.termId) ? { kind: 'empty' } : v))
    },
    [tabs, selectedProjectId]
  )

  /** Show a session's pane — and dismiss the editor and diff layers over it. */
  const focusTab = (termId: number): void => {
    activateFile(null)
    setGitSel(null)
    setView({ kind: 'terminal', termId })
  }

  /**
   * The tab's own hover detail — full label, then which checkout it is in.
   *
   * This is where the tab bar's branch chip went. The chip stated the focused
   * session's branch beside a tab already labelled with the task that branch is
   * named after, and it did so in the widest control on a rail the tabs were
   * being squeezed off. Same facts, no width, and every tab gets them rather
   * than only the focused one.
   */
  const tabTitle = (tab: TerminalTab): string => {
    const lines = [tab.label]
    const wt = tab.worktreeId ? worktrees.find((w) => w.id === tab.worktreeId) : undefined
    if (wt) lines.push(`${wt.branch} · cut from ${wt.baseBranch}`, wt.path)
    const focused = view.kind === 'terminal' && view.termId === tab.termId
    // A pending isolated pane is only borrowing the shared checkout until its
    // first message, so reporting that checkout's state as the session's is
    // the same lie the chip's dashed variant existed to avoid.
    if (focused && pendingBase) lines.push(`New branch, cut from ${pendingBase} on the first message`)
    else if (focused && !wt && repoStatus?.ok && repoStatus.isRepo)
      lines.push(`${repoStatus.branch} · ${repoStatus.upstream ?? 'no upstream'}`)
    if (focused && !pendingBase && repoStatus?.ok && repoStatus.isRepo) {
      const { ahead, behind, files } = repoStatus
      lines.push(
        [
          ahead > 0 || behind > 0 ? `↑${ahead} ↓${behind}` : null,
          files.length > 0
            ? `${files.length} uncommitted change${files.length === 1 ? '' : 's'}`
            : 'clean'
        ]
          .filter(Boolean)
          .join(' · ')
      )
    }
    return lines.join('\n')
  }

  /**
   * Every session of this section for the ⌄ menu, in strip order and with the
   * dormant ones after them — the same two lists the strip renders, so the
   * menu can never disagree with it about what is open.
   */
  const tabMenuItems: TabMenuItem[] = [
    ...visibleTabs.map((tab) => ({
      id: `t${tab.termId}`,
      label: tab.label,
      source: tab.source,
      live: !tab.exited,
      dormant: false,
      active: view.kind === 'terminal' && view.termId === tab.termId,
      root: tab.worktreeId ? (worktrees.find((w) => w.id === tab.worktreeId)?.path ?? null) : null,
      onSelect: () => focusTab(tab.termId)
    })),
    ...dormantTerminals.map((t) => ({
      id: `d${t.sessionId}`,
      label: t.label,
      source: t.source,
      live: false,
      dormant: true,
      active: false,
      onSelect: () => wakeDormant(t)
    }))
  ]

  return (
    <div className="app-layout">
      <div className="sidebar-column">
        {/* hiddenInset traffic lights wired in main process separately */}
        <div className="sidebar-drag-strip" />
        <div className="workflow-switcher-row">
          <WorkflowSwitcher workflow={workflow} onSwitch={setWorkflow} />
          <IconButton
            label="Settings (⌘,)"
            className="app-settings-button"
            onClick={() => openAppSettings()}
          >
            <Settings size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
        {workflow === 'notes' ? (
          <NotesSidebar
            tree={notesTree}
            selected={notesSel}
            onSelectTopic={selectTopic}
            onCreateSubject={createSubject}
            onCreateTopic={createTopic}
            onRenameItem={renameNotesItem}
            onDeleteItem={(p) => void deleteNotesItem(p)}
          />
        ) : workflow === 'todo' ? (
          <TodoSidebar projects={projects} selectedId={todoScopeId} onSelect={setTodoScopeId} />
        ) : (
      <Sidebar
        sessions={visibleSessions}
        hiddenSessions={hiddenSessions}
        projects={projects}
        worktrees={worktrees}
        liveCounts={liveCounts}
        liveSessionIds={new Set(liveSessionTabs.keys())}
        selectedProjectId={selectedProjectId}
        selectedSessionId={
          view.kind === 'terminal'
            ? tabs.find((t) => t.termId === view.termId)?.sessionId
            : undefined
        }
        onHideSession={hideSession}
        onRestoreSession={restoreSession}
        onSelectProject={selectSection}
        onCreateProject={() => void createProject()}
        onSelect={openSession}
        onNewTerminal={() => {
          if (selectedProject) prefetchProject(selectedProject)
          newAgent(selectedProject)
        }}
        onNewIsolated={selectedProject ? () => setWtCreateOpen(true) : undefined}
        liveWorktreeIds={
          new Set(tabs.map((t) => t.worktreeId).filter((id): id is string => !!id))
        }
        onOpenWorktree={openWorktree}
        onRemoveWorktree={confirmRemoveWorktree}
        onReopenWorktree={(wt) => setWorktreeDone(wt, false)}
        onOpenSettings={(id) => setSettingsFor({ id })}
        onRunStart={runStartCommands}
        runTarget={
          activeTab && !activeTab.pending && activeWorktree
            ? { projectId: activeTab.projectId, taskName: activeWorktree.taskName }
            : null
        }
        staleCheckouts={staleCheckouts}
        onSwitchCheckout={(project, to) => void switchCheckout(project, to)}
        onOpenCapabilities={() => setView({ kind: 'capabilities' })}
      />
        )}
      </div>

      <main className="main-panel">
        {appSettingsOpen && (
          <AppSettings
            appearance={appearance}
            onChange={setAppearance}
            agents={agents}
            onAgentsChange={setAgents}
            stt={stt}
            onSttChange={setStt}
            sttHasKey={sttReady}
            sttPending={sttPending}
            onSttStatusChange={refreshSttStatus}
            onSttRecover={recoverRecording}
            onSttDiscardRecording={discardRecording}
            initialPane={settingsPane}
            onClose={() => setAppSettingsOpen(false)}
          />
        )}
        {workflow === 'code' && (
        <div className="terminal-tab-bar">
          <IconButton
            label="Files (⌘⇧E)"
            className="file-tree-toggle"
            onClick={() => {
              setFileTreeOpen((o) => !o)
              setGitOpen(false)
            }}
          >
            <FolderTree size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={gitRoot ? 'Git — changes & history (⌘⇧G)' : 'Git — select a project first'}
            className="git-toggle"
            active={gitOpen}
            disabled={!gitRoot}
            onClick={() => {
              setGitOpen((o) => !o)
              setFileTreeOpen(false)
            }}
          >
            <GitBranch size={16} strokeWidth={1.75} />
            {dirtyCount > 0 && (
              <span className="git-toggle-count">{dirtyCount > 99 ? '99+' : dirtyCount}</span>
            )}
          </IconButton>
          <div
            className={`terminal-tabs-wrap ${strip.left ? 'terminal-tabs-fade-left' : ''} ${strip.right ? 'terminal-tabs-fade-right' : ''}`}
          >
          <div className="terminal-tabs" ref={tabStripRef} onScroll={measureStrip}>
          {visibleTabs.map((tab) => (
            <div
              key={tab.termId}
              data-term-id={tab.termId}
              title={tabTitle(tab)}
              className={`terminal-tab ${view.kind === 'terminal' && view.termId === tab.termId ? 'terminal-tab-active' : ''} ${tab.exited ? 'terminal-tab-exited' : ''} ${draggedTermId === tab.termId ? 'terminal-tab-dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                if ((e.target as HTMLElement).closest('button')) {
                  e.preventDefault()
                  return
                }
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', String(tab.termId))
                setDraggedTermId(tab.termId)
              }}
              onDragOver={(e) => {
                if (draggedTermId === null || draggedTermId === tab.termId) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const fromIndex = visibleTabs.findIndex((t) => t.termId === draggedTermId)
                const overIndex = visibleTabs.findIndex((t) => t.termId === tab.termId)
                if (fromIndex === -1 || overIndex === -1) return
                const box = e.currentTarget.getBoundingClientRect()
                const midpoint = box.left + box.width / 2
                const crossed =
                  fromIndex < overIndex ? e.clientX > midpoint : e.clientX < midpoint
                if (crossed) reorderTab(draggedTermId, tab.termId)
              }}
              onDrop={(e) => e.preventDefault()}
              onDragEnd={() => setDraggedTermId(null)}
              onClick={() => focusTab(tab.termId)}
            >
              {!tab.exited && <Dot tone="live" className="terminal-tab-dot" />}
              <Badge source={tab.source} />
              <span className="terminal-tab-label">{tab.label}</span>
              {tab.worktreeId && (
                <TabDirtyPill
                  root={worktrees.find((w) => w.id === tab.worktreeId)?.path ?? null}
                />
              )}
              <IconButton
                label="Close session"
                dense
                className="terminal-tab-action"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(tab.termId)
                }}
              >
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            </div>
          ))}

          {dormantTerminals.map((t) => (
            <div
              key={`dormant-${t.sessionId}`}
              className="terminal-tab terminal-tab-dormant"
              title="Terminal from a previous app run — click to resume"
              onClick={() => wakeDormant(t)}
            >
              <Play className="terminal-tab-ghost-glyph" size={14} strokeWidth={1.75} />
              <Badge source={t.source} />
              <span className="terminal-tab-label">{t.label}</span>
              <IconButton
                label="Forget this session"
                dense
                className="terminal-tab-action"
                onClick={(e) => {
                  e.stopPropagation()
                  removeDormant(t.sessionId)
                }}
              >
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            </div>
          ))}
          </div>
          </div>

          {/* Only once the strip is genuinely hiding something: a control that
              is always there costs the tabs the width it exists to give back */}
          {strip.overflowing && (
            <TabOverflowButton items={tabMenuItems} hidden={strip.hidden} />
          )}

          {/* Pinned to the far right, outside the scrolling tab strip */}
          <div className="terminal-tab-actions">
            {/* Nothing to update and nothing to ship until the branch exists —
                both would act on the shared checkout this pane is only
                borrowing, which is the whole thing the worktree avoids */}
            {gitRoot && !pendingBase && (
              <UpdateButton
                root={gitRoot}
                status={repoStatus}
                onDone={showToast}
                onError={showToast}
              />
            )}
            {gitRoot && !pendingBase && (
              <ShipButton
                status={repoStatus}
                busy={shipReading === gitRoot}
                onOpen={() => void openShip(gitRoot)}
              />
            )}
            {/* ▷ lives on the sidebar's project row now — a start command is a
                project's, and it can be pressed for one that isn't even open */}
            <IconButton
              label={
                shellWorktree
                  ? `New shell — in ⎇ ${shellWorktree.taskName} or ${selectedProject?.name ?? 'Home'}`
                  : `New shell in ${selectedProject?.name ?? 'Home'}`
              }
              className="new-shell-button"
              onClick={(e) => {
                if (!shellWorktree) {
                  newShell()
                  return
                }
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setShellMenuAt({ x: r.left, y: r.bottom + 4 })
              }}
            >
              <Plus size={18} strokeWidth={1.75} />
            </IconButton>
            {shellMenuAt && shellWorktree && (
              <ContextMenu
                x={shellMenuAt.x}
                y={shellMenuAt.y}
                items={[
                  { id: 'worktree', label: `⎇ ${shellWorktree.taskName}` },
                  { id: 'main', label: `${selectedProject?.name ?? 'Home'} — main checkout` }
                ]}
                onSelect={(id) => {
                  setShellMenuAt(null)
                  newShell(id === 'worktree' ? shellWorktree : undefined)
                }}
                onClose={() => setShellMenuAt(null)}
              />
            )}
          </div>
        </div>
        )}

        <div className="workspace-row">
        <FileTreePanel
          visible={workflow === 'code' && fileTreeOpen}
          root={treeRoot}
          rootLabel={treeRootLabel}
          activePath={sectionFiles.activePath}
          onOpenFile={openFile}
          onClose={() => setFileTreeOpen(false)}
          onError={showToast}
          onDeleted={closeFilesUnder}
          onRenamed={renameOpenFiles}
        />
        <GitPanel
          visible={workflow === 'code' && gitOpen && gitRoot !== null}
          root={treeRoot}
          rootLabel={treeRootLabel}
          status={repoStatus}
          selection={gitSel}
          onShowFile={(file) => {
            activateFile(null)
            setGitSel({ kind: 'file', file })
          }}
          onShowCommit={(hash) => {
            activateFile(null)
            setGitSel({ kind: 'commit', hash })
          }}
          onDiscard={confirmDiscard}
          onClose={() => setGitOpen(false)}
        />
        <div className="main-content">
          {workflow === 'notes' && (
            <div className="notes-main">
              <div className="notes-main-body">
                {currentTopic && notesSel ? (
                  <NotesWorkspace
                    subject={notesSel.subject}
                    topic={currentTopic}
                    selectedNotePath={selectedNotePath}
                    editorTheme={editorTheme}
                    recording={recording}
                    pendingAppend={pendingAppend}
                    onAppendApplied={onAppendApplied}
                    onToggleChat={() => setChatOpen((o) => !o)}
                    sttReady={sttReady}
                    onOpenVoiceSettings={() => openAppSettings('voice')}
                    onStartRecording={startRecording}
                    onStopRecording={stopRecording}
                    onSelectNote={setSelectedNotePath}
                    onCreateNote={createNote}
                    onDeleteNote={(p) => void deleteNotesItem(p)}
                  />
                ) : (
                  <div className="empty-state">
                    <h2>Notes</h2>
                    <p>
                      Pick a topic in the sidebar — or create a subject (“+” next to
                      Subjects), then a topic inside it. Lessons live as markdown files in{' '}
                      {notesTree?.root ?? 'your notes folder'}.
                    </p>
                    <button
                      className="notes-mode-button"
                      onClick={() => setChatOpen((o) => !o)}
                    >
                      ✦ Ask your notes
                    </button>
                  </div>
                )}
              </div>
              <NotesChat
                root={notesTree?.root ?? ''}
                sel={notesSel}
                open={chatOpen}
                onClose={() => setChatOpen(false)}
              />
            </div>
          )}

          {workflow === 'todo' && (
            <TodoBoard
              scopeDir={todoScopeDir}
              scopeName={todoProject?.name ?? 'General'}
              board={todoBoard}
              onAddCard={addTodoCard}
              onMoveCard={moveTodoCard}
              onUpdateCard={updateTodoCard}
              onDeleteCard={deleteTodoCard}
              onArchiveDone={archiveTodoDone}
              runTargetLabel={todoProject?.name ?? 'Home (~)'}
              runAgent={todoRunAgent}
              onRunCard={runTodoCard}
              onFocusRun={focusCardRun}
              runs={cardRuns}
              liveTermIds={liveTermIds}
            />
          )}

          {workflow === 'code' && !editorVisible && view.kind === 'empty' && (
            <div className="empty-state">
              <Terminal className="empty-state-glyph" size={20} strokeWidth={1.5} />
              <h2 className="empty-state-title">
                {selectedProject ? selectedProject.name : 'Chewo'}
              </h2>
              <p>
                {selectedProject
                  ? `Start one with “New session”, or pick up a past one from the sidebar. Scoped to ${selectedProject.path}`
                  : 'Open a project, search past sessions, or start a terminal (runs in your home folder).'}
              </p>
            </div>
          )}

          {workflow === 'code' && !editorVisible && view.kind === 'capabilities' && (
            <CapabilitiesView projects={projects} onClose={() => setView({ kind: 'empty' })} />
          )}

          {/* Panes stay mounted across workflow switches — terminals keep running.
              Fixed termId order so reordering the tab strip never moves a live
              terminal's DOM node (which would corrupt its xterm renderer). */}
          {paneTabs.map((tab) => {
            // Same root resolution as the file tree: isolated sessions resolve
            // clicked paths inside their worktree, not the main checkout
            const tabWorktree = tab.worktreeId
              ? worktrees.find((w) => w.id === tab.worktreeId)
              : undefined
            const tabProject = projects.find((p) => p.id === tab.projectId)
            const paneActive =
              workflow === 'code' &&
              !editorVisible &&
              gitSel === null &&
              view.kind === 'terminal' &&
              view.termId === tab.termId

            if (tab.mode === 'chat') {
              return (
                <ChatPane
                  key={tab.termId}
                  chatId={tab.termId}
                  active={paneActive}
                  source={tab.source === 'shell' ? 'claude' : tab.source}
                  initialPrompt={tab.initialPrompt}
                  initialImages={tab.initialImages}
                  resumeFrom={resumeSourceFor(tab)}
                  onError={showToast}
                  // Consulted on every pane's first message; it returns false
                  // for one already running the agent and checkout it asked for
                  beforeFirstSend={(text, images) => startChosenSession(tab, text, images)}
                  // Only a pane with no process behind it: once the CLI is
                  // running, its agent, model, effort and checkout are facts
                  setup={
                    tab.pending
                      ? (() => {
                          const agent = tab.source === 'shell' ? 'claude' : tab.source
                          const choice = paneChoice(agent, tab.model, tab.effort)
                          return {
                            source: agent,
                            isolate: tab.branchMode === 'separate',
                            models: choice.catalog,
                            model: choice.model,
                            effort: choice.effort,
                            projectName: tabProject?.name,
                            base: tabProject ? (defaultBases.get(tabProject.path) ?? null) : null,
                            baseChoice: tab.baseBranch,
                            branches: tabProject ? branchLists.get(tabProject.path) : undefined,
                            // Only meaningful for the visible pane: `repoStatus`
                            // follows the *active* tab's root, and an unstarted
                            // pane's root is its project's checkout
                            currentBranch:
                              paneActive && repoStatus?.ok && repoStatus.isRepo
                                ? repoStatus.branch
                                : undefined,
                            onChange: (patch) =>
                              setPaneChoice(tab.termId, {
                                source: patch.source,
                                branchMode:
                                  patch.isolate === undefined
                                    ? undefined
                                    : patch.isolate
                                      ? 'separate'
                                      : 'current',
                                base: patch.base,
                                model: patch.model,
                                effort: patch.effort
                              })
                          }
                        })()
                      : undefined
                  }
                  notice={
                    cuttingBranch.has(tab.termId) ? 'Cutting a branch for this task…' : undefined
                  }
                  onSessionBound={(sessionId) => bindChatSession(tab.termId, sessionId)}
                />
              )
            }

            return (
              <TerminalPane
                key={tab.termId}
                termId={tab.termId}
                root={tabWorktree?.path ?? tabProject?.path ?? window.api.homeDir}
                theme={terminalTheme}
                onOpenFile={openFile}
                active={paneActive}
              />
            )
          })}
          <FileEditor
            visible={editorVisible}
            openFiles={sectionFiles.openFiles}
            allOpenPaths={allOpenPaths}
            activePath={sectionFiles.activePath}
            root={treeRoot}
            gotoTarget={gotoTarget}
            theme={editorTheme}
            onActivate={openFile}
            onCloseFile={closeFile}
            onReorderFile={reorderFile}
            onExit={() => activateFile(null)}
          />
          <GitDiffView
            visible={workflow === 'code' && gitSel !== null}
            root={treeRoot}
            target={gitSel}
            onClose={() => setGitSel(null)}
          />
        </div>
        </div>


        {toast && (
          <div className="toast" onClick={() => setToast(null)}>
            <span className="toast-text">{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation()
                  toast.action?.onClick()
                  setToast(null)
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}

        {wtCreateOpen && selectedProject && (
          <WorktreeCreateModal
            project={selectedProject}
            onCancel={() => setWtCreateOpen(false)}
            onCreate={createIsolated}
          />
        )}

        {shipReview && (
          <ShipModal
            root={shipReview.root}
            preview={shipReview.preview}
            onRefresh={() => {
              setShipReview(null)
              void openShip(shipReview.root)
            }}
            rootLabel={shipWorktree ? `⎇ ${shipWorktree.taskName}` : (shipProject?.name ?? 'Ship')}
            onClose={() => setShipReview(null)}
            onShipped={(res) => {
              setShipReview(null)
              onShipped(res, shipWorktree)
            }}
            onRemoveWorktree={
              shipWorktree
                ? () => {
                    setShipReview(null)
                    // No polled state here — the unforced attempt goes first and
                    // its refusal is what asks the discard question
                    confirmRemoveWorktree(shipWorktree, null)
                  }
                : undefined
            }
          />
        )}

        {settingsFor &&
          (() => {
            const target = settingsFor.id
              ? (projects.find((p) => p.id === settingsFor.id) ?? null)
              : null
            if (settingsFor.id && !target) return null
            return (
              <SectionSettingsModal
                name={target?.name ?? 'Home'}
                path={target?.path ?? window.api.homeDir}
                settings={settingsForSection(settingsFor.id)}
                project={
                  target
                    ? {
                        worktreeSetup: target.worktreeSetup,
                        runCommand: target.runCommand,
                        worktreeCopy: target.worktreeCopy
                      }
                    : undefined
                }
                onClose={() => setSettingsFor(null)}
                onSave={(s, p) => saveSectionSettings(settingsFor.id, s, p)}
                onRemove={
                  target
                    ? (deleteBoard) => deleteProject(target.id, deleteBoard, target)
                    : undefined
                }
              />
            )
          })()}
      </main>
    </div>
  )
}
