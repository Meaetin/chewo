import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionMeta, Source } from '../../shared/adapter/types'
import {
  assignProject,
  type Project,
  type ProjectsFile,
  type SavedTerminal
} from '../../shared/projects'
import { Sidebar } from './components/Sidebar'
import { TranscriptView } from './components/TranscriptView'
import { TerminalPane } from './components/TerminalPane'

export interface TerminalTab {
  termId: number
  projectId: string | null
  source: Source
  label: string
  sessionId?: string
  exited: boolean
}

type MainView =
  | { kind: 'transcript'; session: SessionMeta }
  | { kind: 'terminal'; termId: number }
  | { kind: 'empty' }

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [view, setView] = useState<MainView>({ kind: 'empty' })
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 8000)
  }, [])

  const refresh = useCallback(async () => {
    const result = await window.api.listSessions()
    setSessions(result.sessions)
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.loadProjects().then((file: ProjectsFile) => {
      setProjects(file.projects)
      setSelectedProjectId(file.selectedProjectId)
      setHiddenIds(new Set(file.hiddenSessionIds))
      loaded.current = true
    })
    const offChanged = window.api.onSessionsChanged(() => void refresh())
    const offExit = window.api.onTermExit(({ id }) => {
      setTabs((t) => t.map((tab) => (tab.termId === id ? { ...tab, exited: true } : tab)))
    })
    const offBound = window.api.onTermBound(({ id, sessionId, title }) => {
      setTabs((t) =>
        t.map((tab) =>
          tab.termId === id ? { ...tab, sessionId, label: title.slice(0, 30) } : tab
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
      offChanged()
      offExit()
      offBound()
      offHandoff()
    }
  }, [refresh, showToast])

  // Persist projects + remembered terminals whenever state settles.
  // A project's saved list = its live bound tabs + dormant leftovers.
  useEffect(() => {
    if (!loaded.current) return
    const withTerminals = projects.map((p) => {
      const live: SavedTerminal[] = tabs
        .filter((t) => t.projectId === p.id && t.sessionId)
        .map((t) => ({ source: t.source, sessionId: t.sessionId!, label: t.label }))
      const liveIds = new Set(live.map((t) => t.sessionId))
      const dormant = p.terminals.filter((t) => !liveIds.has(t.sessionId))
      return { ...p, terminals: [...live, ...dormant] }
    })
    const file: ProjectsFile = {
      projects: withTerminals,
      selectedProjectId,
      hiddenSessionIds: [...hiddenIds]
    }
    void window.api.saveProjects(file)
  }, [projects, tabs, selectedProjectId, hiddenIds])

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null

  // No project selected = the default workspace: only unscoped terminals
  const visibleTabs = tabs.filter((t) => t.projectId === (selectedProject?.id ?? null))

  const visibleSessions = sessions.filter((s) => !hiddenIds.has(s.id))
  const hiddenSessions = sessions.filter((s) => hiddenIds.has(s.id))

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

  const liveSessionIds = new Set(tabs.map((t) => t.sessionId).filter(Boolean))
  const dormantTerminals = selectedProject
    ? selectedProject.terminals.filter((t) => !liveSessionIds.has(t.sessionId))
    : []

  const openTerminal = useCallback(
    async (opts: {
      source: Source
      sessionId?: string
      cwd?: string | null
      label?: string
      projectId: string | null
    }) => {
      const termId = await window.api.createTerminal({
        source: opts.source,
        sessionId: opts.sessionId,
        cwd: opts.cwd
      })
      setTabs((t) => [
        ...t,
        {
          termId,
          projectId: opts.projectId,
          source: opts.source,
          label: opts.label ?? `${opts.source} (new)`,
          sessionId: opts.sessionId,
          exited: false
        }
      ])
      setView({ kind: 'terminal', termId })
    },
    []
  )

  const newTerminal = useCallback(
    (source: Source) =>
      void openTerminal({
        source,
        // Selected project → its path; no project → $HOME (main falls back)
        cwd: selectedProject?.path ?? null,
        projectId: selectedProject?.id ?? null
      }),
    [openTerminal, selectedProject]
  )

  const resumeSession = useCallback(
    (s: SessionMeta) => {
      const home = assignProject(s, projects)
      void openTerminal({
        source: s.source,
        sessionId: s.id,
        cwd: s.project,
        label: s.title.slice(0, 30),
        projectId: home?.id ?? selectedProject?.id ?? null
      })
    },
    [openTerminal, projects, selectedProject]
  )

  const wakeDormant = useCallback(
    (t: SavedTerminal) => {
      if (!selectedProject) return
      void openTerminal({
        source: t.source,
        sessionId: t.sessionId,
        cwd: selectedProject.path,
        label: t.label,
        projectId: selectedProject.id
      })
    },
    [openTerminal, selectedProject]
  )

  const closeTerminal = useCallback((termId: number) => {
    window.api.termKill(termId)
    setTabs((t) => t.filter((tab) => tab.termId !== termId))
    setView((v) => (v.kind === 'terminal' && v.termId === termId ? { kind: 'empty' } : v))
  }, [])

  const removeDormant = useCallback(
    (sessionId: string) => {
      if (!selectedProject) return
      setProjects((ps) =>
        ps.map((p) =>
          p.id === selectedProject.id
            ? { ...p, terminals: p.terminals.filter((t) => t.sessionId !== sessionId) }
            : p
        )
      )
    },
    [selectedProject]
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
      <Sidebar
        sessions={visibleSessions}
        hiddenSessions={hiddenSessions}
        projects={projects}
        selectedProjectId={selectedProjectId}
        selectedSessionId={view.kind === 'transcript' ? view.session.id : undefined}
        onHideSession={hideSession}
        onRestoreSession={restoreSession}
        onSelectProject={(id) => {
          setSelectedProjectId(id)
          setView({ kind: 'empty' })
        }}
        onCreateProject={() => void createProject()}
        onDeleteProject={deleteProject}
        onSelect={(session) => setView({ kind: 'transcript', session })}
        onNewTerminal={newTerminal}
      />

      <main className="main-panel">
        <div className="terminal-tab-bar">
          {visibleTabs.map((tab) => (
            <div
              key={tab.termId}
              className={`terminal-tab ${view.kind === 'terminal' && view.termId === tab.termId ? 'terminal-tab-active' : ''} ${tab.exited ? 'terminal-tab-exited' : ''}`}
              onClick={() => setView({ kind: 'terminal', termId: tab.termId })}
            >
              <span className={`source-badge source-badge-${tab.source}`}>
                {tab.source === 'claude' ? 'CC' : 'CX'}
              </span>
              <span className="terminal-tab-label">{tab.label}</span>
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

        <div className="main-content">
          {view.kind === 'empty' && (
            <div className="empty-state">
              <h2>{selectedProject ? selectedProject.name : 'Chewo'}</h2>
              <p>
                {selectedProject
                  ? `Sessions and terminals scoped to ${selectedProject.path}`
                  : 'Open a project, search past sessions, or start a terminal (runs in your home folder).'}
              </p>
            </div>
          )}

          {view.kind === 'transcript' && (
            <TranscriptView key={view.session.id} session={view.session} onResume={resumeSession} />
          )}

          {tabs.map((tab) => (
            <TerminalPane
              key={tab.termId}
              termId={tab.termId}
              active={view.kind === 'terminal' && view.termId === tab.termId}
            />
          ))}
        </div>

        {toast && (
          <div className="toast" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}
      </main>
    </div>
  )
}
