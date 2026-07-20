import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree, GitMerge, Play, Plus, Settings, Terminal, X } from 'lucide-react'
import { DEFAULT_APPEARANCE, type AppearanceSettings } from '../../shared/appearance'
import type { SessionMeta, Source } from '../../shared/adapter/types'
import {
  assignProject,
  type AgentSettings,
  type Project,
  type ProjectsFile,
  type SavedTerminal,
  type Workflow,
  type Worktree
} from '../../shared/projects'
import { DEFAULT_STT_MODEL, type NoteSource, type NotesTree } from '../../shared/notes'
import {
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
import { TranscriptView } from './components/TranscriptView'
import { TerminalPane } from './components/TerminalPane'
import { CapabilitiesView } from './components/CapabilitiesView'
import { FileTreePanel } from './components/FileTreePanel'
import { FileEditor } from './components/FileEditor'
import { WorktreeCreateModal, WorktreeMergeModal } from './components/WorktreeModals'
import { SectionSettingsModal } from './components/SectionSettingsModal'
import { AppSettings } from './components/settings/AppSettings'
import { applyAppearance } from './theme/applyAppearance'
import { makeTerminalTheme } from './theme/terminalTheme'
import { makeEditorTheme } from './theme/editorTheme'
import { Badge, Dot, IconButton } from './components/ui'
import { reorderOpenFiles } from './fileTabs'

export type PaneSource = Source | 'shell'

export interface TerminalTab {
  termId: number
  projectId: string | null
  source: PaneSource
  label: string
  sessionId?: string
  /** Pane runs in an isolated worktree — gets the merge button, keeps its ⎇ label */
  worktreeId?: string
  exited: boolean
}

type MainView =
  | { kind: 'transcript'; session: SessionMeta }
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

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [draggedTermId, setDraggedTermId] = useState<number | null>(null)
  const [view, setView] = useState<MainView>({ kind: 'empty' })
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [homeTerminals, setHomeTerminals] = useState<SavedTerminal[]>([])
  const [homeSettings, setHomeSettings] = useState<AgentSettings>({})
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [wtCreateOpen, setWtCreateOpen] = useState(false)
  const [wtMerge, setWtMerge] = useState<Worktree | null>(null)
  /** Section whose settings modal is open — string id, or null for Home */
  const [settingsFor, setSettingsFor] = useState<{ id: string | null } | null>(null)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [appearance, setAppearance] = useState<AppearanceSettings>(DEFAULT_APPEARANCE)
  const appearanceLoaded = useRef(false)
  const [toast, setToast] = useState<string | null>(null)
  const [workflow, setWorkflow] = useState<Workflow>('code')
  const [notesTree, setNotesTree] = useState<NotesTree | null>(null)
  const [notesSel, setNotesSel] = useState<TopicRef | null>(null)
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null)
  const [recording, setRecording] = useState<RecordingState | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  /** Board scope in the todo workflow — a project id, or null for General */
  const [todoScopeId, setTodoScopeId] = useState<string | null>(null)
  const [todoBoard, setTodoBoard] = useState<BoardFile | null>(null)
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
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
  const selectedNotePathRef = useRef<string | null>(null)
  selectedNotePathRef.current = selectedNotePath
  const notesRoot = useRef<string | undefined>(undefined)
  const todoHotkey = useRef<string | undefined>(undefined)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)
  // Last-viewed terminal per section, so switching sections lands you back
  // where you were instead of on an empty state
  const lastViewedTerm = useRef(new Map<string | null, number>())

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 8000)
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
      setRecording({ phase: 'structuring', ref: rec.ref, notePath: rec.notePath })
      const res = await window.api.notesStructure({
        lessonPath: rec.notePath,
        transcript,
        durationS,
        sttModel: DEFAULT_STT_MODEL
      })

      // A failed pass still lands in the lesson — as the raw transcript
      const when = new Date().toLocaleString()
      const stamp = res.ok
        ? `*Dictated ${when}*`
        : `*Dictated ${when} — structuring failed, raw transcript:*`
      const addition = `---\n\n${stamp}\n\n${(res.ok ? (res.body ?? '') : transcript).trim()}`

      const editorMounted =
        workflowRef.current === 'notes' &&
        selectedNotePathRef.current === rec.notePath &&
        notesSelRef.current?.subject === rec.ref.subject &&
        notesSelRef.current?.topic === rec.ref.topic
      if (editorMounted) {
        setPendingAppend({ id: ++appendSeq.current, path: rec.notePath, text: addition })
      } else {
        try {
          const existing = await window.api.notesRead(rec.notePath)
          await window.api.notesWrite(
            rec.notePath,
            existing.replace(/\s+$/, '') + '\n\n' + addition + '\n'
          )
        } catch {
          showToast('Lesson file is gone — the transcript is kept in its .raw.md twin.')
        }
      }

      setRecording(null)
      void refreshNotes()
      if (!res.ok) showToast(`Structuring failed: ${res.error ?? 'unknown'} — appended raw transcript.`)
    },
    [refreshNotes, showToast]
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
      notesRoot.current = file.notesRoot
      todoHotkey.current = file.todoHotkey
      loaded.current = true
    })
    void window.api.loadSettings().then((file) => {
      setAppearance(file.appearance)
      appearanceLoaded.current = true
    })
    const offNotes = window.api.onNotesChanged(() => void refreshNotes())
    const offStt = window.api.onSttEvent((ev) => {
      switch (ev.event) {
        case 'ready':
          setRecording((r) =>
            r && r.phase === 'loading'
              ? {
                  phase: 'recording',
                  ref: r.ref,
                  notePath: r.notePath,
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
          break
      }
    })
    const offToast = window.api.onAppToast((message) => showToast(message))
    const offChanged = window.api.onSessionsChanged(() => void refresh())
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
          worktreeId: t.worktreeId
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
      todoHotkey: todoHotkey.current
    }
    void window.api.saveProjects(file)
  }, [projects, tabs, selectedProjectId, hiddenIds, homeTerminals, homeSettings, worktrees, workflow])

  // ---------- appearance ----------

  // Live re-theme: CSS tokens for the whole UI, plus derived themes for the
  // two JS-painted surfaces (xterm, CodeMirror)
  useEffect(() => applyAppearance(appearance), [appearance])
  const terminalTheme = useMemo(() => makeTerminalTheme(appearance), [appearance])
  const editorTheme = useMemo(() => makeEditorTheme(appearance), [appearance])

  // Persist debounced — dragging the macOS color picker fires per-frame changes
  useEffect(() => {
    if (!appearanceLoaded.current) return
    const t = setTimeout(() => void window.api.saveSettings({ appearance }), 400)
    return () => clearTimeout(t)
  }, [appearance])

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null
  const wtMergeProject = wtMerge
    ? (projects.find((p) => p.id === wtMerge.projectId) ?? null)
    : null

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
  const treeRoot = activeWorktree?.path ?? selectedProject?.path ?? window.api.homeDir
  const treeRootLabel = activeWorktree
    ? `⎇ ${activeWorktree.taskName}`
    : (selectedProject?.name ?? 'Home')

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

  // ⌘⇧E toggles the file tree anywhere in the code workflow — including with
  // terminal focus (xterm doesn't swallow it; see TerminalPane key handler)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        if (workflowRef.current === 'code') setFileTreeOpen((o) => !o)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setAppSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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

  const openSession = useCallback(
    (s: SessionMeta) => {
      const tab = tabs.find((t) => t.sessionId === s.id)
      if (tab) {
        setSelectedProjectId(tab.projectId) // may jump sections (e.g. from search)
        setView({ kind: 'terminal', termId: tab.termId })
      } else {
        setView({ kind: 'transcript', session: s })
      }
    },
    [tabs]
  )

  const openTranscript = useCallback((s: SessionMeta) => {
    setView({ kind: 'transcript', session: s })
  }, [])

  const selectSection = useCallback(
    (id: string | null) => {
      setSelectedProjectId(id)
      const sectionTabs = tabs.filter((t) => t.projectId === id)
      if (sectionTabs.length === 0) {
        setView({ kind: 'empty' })
        return
      }
      const remembered = lastViewedTerm.current.get(id)
      const target = sectionTabs.find((t) => t.termId === remembered) ?? sectionTabs[sectionTabs.length - 1]
      setView({ kind: 'terminal', termId: target.termId })
    },
    [tabs]
  )

  const hideSession = useCallback((id: string) => {
    setHiddenIds((prev) => new Set(prev).add(id))
    // If the hidden session's transcript is open, close it
    setView((v) => (v.kind === 'transcript' && v.session.id === id ? { kind: 'empty' } : v))
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

  const openTerminal = useCallback(
    async (opts: {
      source: PaneSource
      sessionId?: string
      cwd?: string | null
      label?: string
      projectId: string | null
      worktreeId?: string
      setupCommand?: string
      runCommand?: string
    }) => {
      const { claudeMode, codexApproval } = settingsForSection(opts.projectId)
      const termId = await window.api.createTerminal({
        source: opts.source,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        setupCommand: opts.setupCommand,
        runCommand: opts.runCommand,
        permissionMode: claudeMode,
        approvalPolicy: codexApproval
      })
      setTabs((t) => [
        ...t,
        {
          termId,
          projectId: opts.projectId,
          source: opts.source,
          label: opts.label ?? `${opts.source} (new)`,
          sessionId: opts.sessionId,
          worktreeId: opts.worktreeId,
          exited: false
        }
      ])
      setView({ kind: 'terminal', termId })
    },
    [settingsForSection]
  )

  const newTerminal = useCallback(
    (source: PaneSource) =>
      void openTerminal({
        source,
        // Selected project → its path; no project → $HOME (main falls back)
        cwd: selectedProject?.path ?? null,
        projectId: selectedProject?.id ?? null,
        label: source === 'shell' ? 'zsh' : undefined
      }),
    [openTerminal, selectedProject]
  )

  /** Play button: one shell per non-empty line of the section's start command. */
  const runStartCommands = useCallback(() => {
    const lines = (selectedProject?.runCommand?.trim() || 'npm run dev')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    for (const line of lines) {
      void openTerminal({
        source: 'shell',
        cwd: selectedProject?.path ?? null,
        projectId: selectedProject?.id ?? null,
        label: line.length > 24 ? `${line.slice(0, 24)}…` : line,
        runCommand: line
      })
    }
  }, [openTerminal, selectedProject])

  const resumeSession = useCallback(
    (s: SessionMeta) => {
      // A session belongs to the section its cwd lives in — Home included.
      // Never inherit the selected project, or a Home session resumed while
      // some project is open would show up as that project's terminal.
      const owner = assignProject(s, projects, worktrees)
      const projectId = owner?.id ?? null
      setSelectedProjectId(projectId) // follow the terminal to its own section
      void openTerminal({
        source: s.source,
        sessionId: s.id,
        cwd: s.project,
        label: s.title.slice(0, 30),
        projectId
      })
    },
    [openTerminal, projects, worktrees]
  )

  const wakeDormant = useCallback(
    (t: SavedTerminal) => {
      const wt = t.worktreeId ? worktrees.find((w) => w.id === t.worktreeId) : undefined
      void openTerminal({
        source: t.source,
        sessionId: t.sessionId,
        cwd: wt?.path ?? selectedProject?.path ?? null,
        label: t.label,
        projectId: selectedProject?.id ?? null,
        worktreeId: wt?.id
      })
    },
    [openTerminal, selectedProject, worktrees]
  )

  /** Create worktree + branch, remember it, launch the agent inside. Error string or null. */
  const createIsolated = useCallback(
    async (taskName: string, agent: Source, setup: string): Promise<string | null> => {
      const project = selectedProject
      if (!project) return 'Select a project first'
      const res = await window.api.createWorktree({ projectPath: project.path, taskName })
      if (!res.ok) return res.error
      const wt: Worktree = {
        id: crypto.randomUUID(),
        projectId: project.id,
        taskName,
        branch: res.branch,
        path: res.path,
        baseBranch: res.baseBranch,
        createdAt: new Date().toISOString()
      }
      setWorktrees((ws) => [...ws, wt])
      const trimmedSetup = setup.trim()
      if (trimmedSetup !== (project.worktreeSetup ?? '')) {
        setProjects((ps) =>
          ps.map((p) =>
            p.id === project.id ? { ...p, worktreeSetup: trimmedSetup || undefined } : p
          )
        )
      }
      setWtCreateOpen(false)
      void openTerminal({
        source: agent,
        cwd: res.path,
        projectId: project.id,
        label: `⎇ ${taskName}`,
        worktreeId: wt.id,
        setupCommand: trimmedSetup || undefined
      })
      return null
    },
    [selectedProject, openTerminal]
  )

  /** git worktree remove + branch -d, then drop panes/tabs/records. Error string or null. */
  const removeWorktree = useCallback(
    async (wt: Worktree): Promise<string | null> => {
      const project = projects.find((p) => p.id === wt.projectId)
      if (!project) return 'Project no longer exists'
      const res = await window.api.worktreeRemove({
        projectPath: project.path,
        worktreePath: wt.path,
        branch: wt.branch
      })
      if (!res.ok) return res.error
      const killed = tabs.filter((t) => t.worktreeId === wt.id).map((t) => t.termId)
      for (const id of killed) window.api.termKill(id)
      setTabs((ts) => ts.filter((t) => t.worktreeId !== wt.id))
      setView((v) => (v.kind === 'terminal' && killed.includes(v.termId) ? { kind: 'empty' } : v))
      setWorktrees((ws) => ws.filter((w) => w.id !== wt.id))
      setProjects((ps) =>
        ps.map((p) => ({ ...p, terminals: p.terminals.filter((t) => t.worktreeId !== wt.id) }))
      )
      setWtMerge(null)
      if (!res.branchDeleted && res.note) showToast(res.note)
      return null
    },
    [projects, tabs, showToast]
  )

  const closeTerminal = useCallback(
    (termId: number) => {
      window.api.termKill(termId)
      const closing = tabs.find((tab) => tab.termId === termId)
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
    (id: string | null, settings: AgentSettings, worktreeSetup?: string, runCommand?: string) => {
      if (id === null) {
        setHomeSettings(settings)
        return
      }
      setProjects((ps) =>
        ps.map((p) => (p.id === id ? { ...p, ...settings, worktreeSetup, runCommand } : p))
      )
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

  // Entering the notes workflow prewarms the STT model — the load overlaps
  // picking a subject/topic, so hitting record feels instant (SPEC-TODOS §6)
  useEffect(() => {
    if (workflow === 'notes') window.api.sttPrewarm(DEFAULT_STT_MODEL)
  }, [workflow])

  const startRecording = useCallback(() => {
    if (!notesSel || !selectedNotePath || recordingRef.current) return
    setRecording({ phase: 'loading', ref: notesSel, notePath: selectedNotePath })
    window.api.sttStart(DEFAULT_STT_MODEL)
  }, [notesSel, selectedNotePath])

  const stopRecording = useCallback(() => {
    window.api.sttStop()
  }, [])

  const deleteNote = useCallback(
    async (path: string) => {
      const res = await window.api.notesDelete(path)
      if (!res.ok) showToast(res.error ?? 'Could not delete note')
      setSelectedNotePath((p) => (p === path ? null : p))
      void refreshNotes()
    },
    [refreshNotes, showToast]
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
      for (const tab of doomed) window.api.termKill(tab.termId)
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
            onClick={() => setAppSettingsOpen(true)}
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
          view.kind === 'transcript'
            ? view.session.id
            : view.kind === 'terminal'
              ? tabs.find((t) => t.termId === view.termId)?.sessionId
              : undefined
        }
        onHideSession={hideSession}
        onRestoreSession={restoreSession}
        onOpenTranscript={openTranscript}
        onSelectProject={selectSection}
        onCreateProject={() => void createProject()}
        onSelect={openSession}
        onNewTerminal={newTerminal}
        onNewIsolated={selectedProject ? () => setWtCreateOpen(true) : undefined}
        onOpenSettings={(id) => setSettingsFor({ id })}
        onOpenCapabilities={() => setView({ kind: 'capabilities' })}
      />
        )}
      </div>

      <main className="main-panel">
        {appSettingsOpen && (
          <AppSettings
            appearance={appearance}
            onChange={setAppearance}
            onClose={() => setAppSettingsOpen(false)}
          />
        )}
        {workflow === 'code' && (
        <div className="terminal-tab-bar">
          <IconButton
            label="Files (⌘⇧E)"
            className="file-tree-toggle"
            onClick={() => setFileTreeOpen((o) => !o)}
          >
            <FolderTree size={16} strokeWidth={1.75} />
          </IconButton>
          <div className="terminal-tabs">
          {visibleTabs.map((tab) => (
            <div
              key={tab.termId}
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
              onClick={() => {
                // Clicking the session tab also dismisses the editor layer
                activateFile(null)
                setView({ kind: 'terminal', termId: tab.termId })
              }}
            >
              {!tab.exited && <Dot tone="live" className="terminal-tab-dot" />}
              <Badge source={tab.source} />
              <span className="terminal-tab-label">{tab.label}</span>
              {tab.worktreeId && (
                <IconButton
                  label="Review & merge this worktree into the main checkout"
                  dense
                  className="terminal-tab-action"
                  onClick={(e) => {
                    e.stopPropagation()
                    setWtMerge(worktrees.find((w) => w.id === tab.worktreeId) ?? null)
                  }}
                >
                  <GitMerge size={14} strokeWidth={1.75} />
                </IconButton>
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
              {t.worktreeId && (
                <IconButton
                  label="Review & merge this worktree into the main checkout"
                  dense
                  className="terminal-tab-action"
                  onClick={(e) => {
                    e.stopPropagation()
                    setWtMerge(worktrees.find((w) => w.id === t.worktreeId) ?? null)
                  }}
                >
                  <GitMerge size={14} strokeWidth={1.75} />
                </IconButton>
              )}
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

          {/* Pinned to the far right, outside the scrolling tab strip */}
          <div className="terminal-tab-actions">
            <IconButton
              label={`Run start command in ${selectedProject?.name ?? 'Home'}`}
              className="run-start-button"
              onClick={runStartCommands}
            >
              <Play size={16} strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label={`New shell in ${selectedProject?.name ?? 'Home'}`}
              className="new-shell-button"
              onClick={() => newTerminal('shell')}
            >
              <Plus size={18} strokeWidth={1.75} />
            </IconButton>
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
                    onStartRecording={startRecording}
                    onStopRecording={stopRecording}
                    onSelectNote={setSelectedNotePath}
                    onCreateNote={createNote}
                    onDeleteNote={(p) => void deleteNote(p)}
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
                  ? `Sessions and terminals scoped to ${selectedProject.path}`
                  : 'Open a project, search past sessions, or start a terminal (runs in your home folder).'}
              </p>
            </div>
          )}

          {workflow === 'code' && !editorVisible && view.kind === 'transcript' && (
            <TranscriptView key={view.session.id} session={view.session} onResume={resumeSession} />
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
            return (
              <TerminalPane
                key={tab.termId}
                termId={tab.termId}
                root={tabWorktree?.path ?? tabProject?.path ?? window.api.homeDir}
                theme={terminalTheme}
                onOpenFile={openFile}
                active={
                  workflow === 'code' &&
                  !editorVisible &&
                  view.kind === 'terminal' &&
                  view.termId === tab.termId
                }
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
        </div>
        </div>

        {toast && (
          <div className="toast" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}

        {wtCreateOpen && selectedProject && (
          <WorktreeCreateModal
            project={selectedProject}
            onCancel={() => setWtCreateOpen(false)}
            onCreate={createIsolated}
          />
        )}

        {wtMerge && wtMergeProject && (
          <WorktreeMergeModal
            worktree={wtMerge}
            project={wtMergeProject}
            onClose={() => setWtMerge(null)}
            onRemove={() => removeWorktree(wtMerge)}
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
                worktreeSetup={target?.worktreeSetup}
                runCommand={target?.runCommand}
                showWorktreeSetup={!!target}
                onClose={() => setSettingsFor(null)}
                onSave={(s, setup, run) => saveSectionSettings(settingsFor.id, s, setup, run)}
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
