import { useCallback, useEffect, useRef, useState } from 'react'
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
import { Sidebar } from './components/Sidebar'
import { NotesSidebar, type TopicRef } from './components/NotesSidebar'
import { NotesWorkspace, type RecordingState } from './components/NotesWorkspace'
import { WorkflowSwitcher } from './components/WorkflowSwitcher'
import { TranscriptView } from './components/TranscriptView'
import { TerminalPane } from './components/TerminalPane'
import { CapabilitiesView } from './components/CapabilitiesView'
import { WorktreeCreateModal, WorktreeMergeModal } from './components/WorktreeModals'
import { SectionSettingsModal } from './components/SectionSettingsModal'

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

const BADGES: Record<PaneSource, string> = { claude: 'CC', codex: 'CX', shell: 'SH' }

type MainView =
  | { kind: 'transcript'; session: SessionMeta }
  | { kind: 'terminal'; termId: number }
  | { kind: 'capabilities' }
  | { kind: 'empty' }

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [tabs, setTabs] = useState<TerminalTab[]>([])
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
  const [toast, setToast] = useState<string | null>(null)
  const [workflow, setWorkflow] = useState<Workflow>('code')
  const [notesTree, setNotesTree] = useState<NotesTree | null>(null)
  const [notesSel, setNotesSel] = useState<TopicRef | null>(null)
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null)
  const [recording, setRecording] = useState<RecordingState | null>(null)
  const recordingRef = useRef<RecordingState | null>(null)
  recordingRef.current = recording
  const notesRoot = useRef<string | undefined>(undefined)
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

  /** stt 'final' → write raw twin, run the claude -p structuring pass, open the note. */
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
      setRecording({ phase: 'structuring', ref: rec.ref })
      const res = await window.api.notesStructure({
        subject: rec.ref.subject,
        topic: rec.ref.topic,
        transcript,
        durationS,
        sttModel: DEFAULT_STT_MODEL
      })
      setRecording(null)
      await refreshNotes()
      if (res.path) {
        setNotesSel(rec.ref)
        setSelectedNotePath(res.path)
      }
      if (!res.ok) {
        showToast(
          `Structuring failed: ${res.error ?? 'unknown'} — the raw transcript was saved as a note instead.`
        )
      }
    },
    [refreshNotes, showToast]
  )

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
      loaded.current = true
    })
    const offNotes = window.api.onNotesChanged(() => void refreshNotes())
    const offStt = window.api.onSttEvent((ev) => {
      switch (ev.event) {
        case 'ready':
          setRecording((r) =>
            r && r.phase === 'loading'
              ? { phase: 'recording', ref: r.ref, confirmed: '', tail: '', level: 0, startedAt: Date.now() }
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
      notesRoot: notesRoot.current
    }
    void window.api.saveProjects(file)
  }, [projects, tabs, selectedProjectId, hiddenIds, homeTerminals, homeSettings, worktrees, workflow])

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null
  const wtMergeProject = wtMerge
    ? (projects.find((p) => p.id === wtMerge.projectId) ?? null)
    : null

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
  const liveCounts = new Map<string | null, number>()
  for (const t of tabs) liveCounts.set(t.projectId, (liveCounts.get(t.projectId) ?? 0) + 1)

  const visibleSessions = sessions.filter((s) => !hiddenIds.has(s.id))
  const hiddenSessions = sessions.filter((s) => hiddenIds.has(s.id))

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
    }) => {
      const { claudeMode, codexApproval } = settingsForSection(opts.projectId)
      const termId = await window.api.createTerminal({
        source: opts.source,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        setupCommand: opts.setupCommand,
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
    (id: string | null, settings: AgentSettings, worktreeSetup?: string) => {
      if (id === null) {
        setHomeSettings(settings)
        return
      }
      setProjects((ps) =>
        ps.map((p) => (p.id === id ? { ...p, ...settings, worktreeSetup } : p))
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

  const startRecording = useCallback(() => {
    if (!notesSel || recordingRef.current) return
    setRecording({ phase: 'loading', ref: notesSel })
    window.api.sttStart(DEFAULT_STT_MODEL)
  }, [notesSel])

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

  const createProject = useCallback(async () => {
    const path = await window.api.pickFolder()
    if (!path) return
    const name = path.split('/').pop() ?? path
    const project: Project = { id: crypto.randomUUID(), name, path, terminals: [] }
    setProjects((ps) => [...ps, project])
    setSelectedProjectId(project.id)
  }, [])

  const deleteProject = useCallback(
    (id: string) => {
      setProjects((ps) => ps.filter((p) => p.id !== id))
      if (selectedProjectId === id) setSelectedProjectId(null)
      // Live tabs of a deleted project fall back to the "All" view
      setTabs((t) => t.map((tab) => (tab.projectId === id ? { ...tab, projectId: null } : tab)))
    },
    [selectedProjectId]
  )

  return (
    <div className="app-layout">
      <div className="sidebar-column">
        <WorkflowSwitcher workflow={workflow} onSwitch={setWorkflow} />
        {workflow === 'notes' ? (
          <NotesSidebar
            tree={notesTree}
            selected={notesSel}
            onSelectTopic={selectTopic}
            onCreateSubject={createSubject}
            onCreateTopic={createTopic}
          />
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
        {workflow === 'code' && (
        <div className="terminal-tab-bar">
          {visibleTabs.map((tab) => (
            <div
              key={tab.termId}
              className={`terminal-tab ${view.kind === 'terminal' && view.termId === tab.termId ? 'terminal-tab-active' : ''} ${tab.exited ? 'terminal-tab-exited' : ''}`}
              onClick={() => setView({ kind: 'terminal', termId: tab.termId })}
            >
              <span className={`source-badge source-badge-${tab.source}`}>
                {BADGES[tab.source]}
              </span>
              <span className="terminal-tab-label">{tab.label}</span>
              {tab.worktreeId && (
                <button
                  className="terminal-tab-merge"
                  title="Review & merge this worktree into the main checkout"
                  onClick={(e) => {
                    e.stopPropagation()
                    setWtMerge(worktrees.find((w) => w.id === tab.worktreeId) ?? null)
                  }}
                >
                  ⇤
                </button>
              )}
              <button
                className="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(tab.termId)
                }}
              >
                ×
              </button>
            </div>
          ))}

          <button
            className="new-shell-button"
            title={`New shell in ${selectedProject?.name ?? 'Home'}`}
            onClick={() => newTerminal('shell')}
          >
            +
          </button>

          {dormantTerminals.map((t) => (
            <div
              key={`dormant-${t.sessionId}`}
              className="terminal-tab terminal-tab-dormant"
              title="Terminal from a previous app run — click to resume"
              onClick={() => wakeDormant(t)}
            >
              <span className={`source-badge source-badge-${t.source}`}>
                {t.source === 'claude' ? 'CC' : 'CX'}
              </span>
              <span className="terminal-tab-label">▶ {t.label}</span>
              {t.worktreeId && (
                <button
                  className="terminal-tab-merge"
                  title="Review & merge this worktree into the main checkout"
                  onClick={(e) => {
                    e.stopPropagation()
                    setWtMerge(worktrees.find((w) => w.id === t.worktreeId) ?? null)
                  }}
                >
                  ⇤
                </button>
              )}
              <button
                className="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  removeDormant(t.sessionId)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        )}

        <div className="main-content">
          {workflow === 'notes' &&
            (currentTopic && notesSel ? (
              <NotesWorkspace
                subject={notesSel.subject}
                topic={currentTopic}
                selectedNotePath={selectedNotePath}
                recording={recording}
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
                  Pick a topic in the sidebar — or create a subject (“+” next to Subjects),
                  then a topic inside it. Notes live as markdown files in{' '}
                  {notesTree?.root ?? '~/ChewoNotes'}.
                </p>
              </div>
            ))}

          {workflow === 'code' && view.kind === 'empty' && (
            <div className="empty-state">
              <h2>{selectedProject ? selectedProject.name : 'Chewo'}</h2>
              <p>
                {selectedProject
                  ? `Sessions and terminals scoped to ${selectedProject.path}`
                  : 'Open a project, search past sessions, or start a terminal (runs in your home folder).'}
              </p>
            </div>
          )}

          {workflow === 'code' && view.kind === 'transcript' && (
            <TranscriptView key={view.session.id} session={view.session} onResume={resumeSession} />
          )}

          {workflow === 'code' && view.kind === 'capabilities' && (
            <CapabilitiesView projects={projects} onClose={() => setView({ kind: 'empty' })} />
          )}

          {/* Panes stay mounted across workflow switches — terminals keep running */}
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.termId}
              termId={tab.termId}
              active={workflow === 'code' && view.kind === 'terminal' && view.termId === tab.termId}
            />
          ))}
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
                showWorktreeSetup={!!target}
                onClose={() => setSettingsFor(null)}
                onSave={(s, setup) => saveSectionSettings(settingsFor.id, s, setup)}
                onRemove={target ? () => deleteProject(target.id) : undefined}
              />
            )
          })()}
      </main>
    </div>
  )
}
