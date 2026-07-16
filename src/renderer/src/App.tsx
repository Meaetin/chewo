import { useCallback, useEffect, useState } from 'react'
import type { SessionMeta } from '../../shared/adapter/types'
import { Sidebar } from './components/Sidebar'
import { TranscriptView } from './components/TranscriptView'
import { TerminalPane } from './components/TerminalPane'

export interface TerminalTab {
  termId: number
  source: 'claude' | 'codex'
  label: string
  exited: boolean
}

/** What the main panel is showing: a session transcript or a live terminal */
type MainView = { kind: 'transcript'; session: SessionMeta } | { kind: 'terminal'; termId: number } | { kind: 'empty' }

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [terminals, setTerminals] = useState<TerminalTab[]>([])
  const [view, setView] = useState<MainView>({ kind: 'empty' })

  const refresh = useCallback(async () => {
    const result = await window.api.listSessions()
    setSessions(result.sessions)
  }, [])

  useEffect(() => {
    void refresh()
    const offChanged = window.api.onSessionsChanged(() => void refresh())
    const offExit = window.api.onTermExit(({ id }) => {
      setTerminals((tabs) => tabs.map((t) => (t.termId === id ? { ...t, exited: true } : t)))
    })
    return () => {
      offChanged()
      offExit()
    }
  }, [refresh])

  const openTerminal = useCallback(
    async (source: 'claude' | 'codex', sessionId?: string, cwd?: string | null, label?: string) => {
      const termId = await window.api.createTerminal({ source, sessionId, cwd })
      setTerminals((tabs) => [
        ...tabs,
        { termId, source, label: label ?? `${source} (new)`, exited: false }
      ])
      setView({ kind: 'terminal', termId })
    },
    []
  )

  const closeTerminal = useCallback((termId: number) => {
    window.api.termKill(termId)
    setTerminals((tabs) => tabs.filter((t) => t.termId !== termId))
    setView((v) => (v.kind === 'terminal' && v.termId === termId ? { kind: 'empty' } : v))
  }, [])

  return (
    <div className="app-layout">
      <Sidebar
        sessions={sessions}
        selectedId={view.kind === 'transcript' ? view.session.id : undefined}
        onSelect={(session) => setView({ kind: 'transcript', session })}
        onNewTerminal={(source) => void openTerminal(source)}
      />

      <main className="main-panel">
        <div className="terminal-tab-bar">
          {terminals.map((tab) => (
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
        </div>

        <div className="main-content">
          {view.kind === 'empty' && (
            <div className="empty-state">
              <h2>Cohesion</h2>
              <p>Select a session from the sidebar, or start a new terminal.</p>
            </div>
          )}

          {view.kind === 'transcript' && (
            <TranscriptView
              key={view.session.id}
              session={view.session}
              onResume={(s) =>
                void openTerminal(s.source, s.id, s.project, s.title.slice(0, 30))
              }
            />
          )}

          {/* All terminal panes stay mounted so scrollback survives tab switches */}
          {terminals.map((tab) => (
            <TerminalPane
              key={tab.termId}
              termId={tab.termId}
              active={view.kind === 'terminal' && view.termId === tab.termId}
            />
          ))}
        </div>
      </main>
    </div>
  )
}
