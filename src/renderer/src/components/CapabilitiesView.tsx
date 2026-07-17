import { useEffect, useState } from 'react'
import type { CapabilityInventory } from '../../../shared/capabilities/types'
import type { Project } from '../../../shared/projects'

interface CapabilitiesViewProps {
  projects: Project[]
}

function scopeTitle(inv: CapabilityInventory): string {
  if (inv.scope.kind === 'global') {
    return inv.scope.tool === 'claude' ? 'Personal · Claude Code' : 'Personal · Codex'
  }
  return inv.scope.name
}

function scopeSubtitle(inv: CapabilityInventory): string {
  return inv.scope.kind === 'global'
    ? inv.scope.tool === 'claude'
      ? '~/.claude'
      : '~/.codex'
    : inv.scope.path
}

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`

export function CapabilitiesView({ projects }: CapabilitiesViewProps): React.JSX.Element {
  const [inventories, setInventories] = useState<CapabilityInventory[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .scanCapabilities(projects.map((p) => ({ id: p.id, name: p.name, path: p.path })))
      .then((result: CapabilityInventory[]) => {
        if (!cancelled) setInventories(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projects])

  return (
    <div className="capabilities-view">
      <header className="capabilities-header">
        <h2>Capabilities</h2>
        <p className="capabilities-subtitle">
          What each scope gives your agents — instructions, skills, subagents, MCP servers. Read-only for now.
        </p>
      </header>

      <div className="capabilities-scopes">
        {error && <div className="transcript-error">{error}</div>}
        {!inventories && !error && <div className="transcript-loading">Scanning…</div>}

        {inventories?.map((inv, i) => (
          <section key={i} className="capability-card">
            <div className="capability-card-header">
              <span className="capability-scope-name">{scopeTitle(inv)}</span>
              <span className="capability-scope-path">{scopeSubtitle(inv)}</span>
            </div>

            <div className="capability-group">
              <div className="capability-group-title">Instructions</div>
              {inv.memory.claudeMd && (
                <div className="capability-row">
                  <span className="source-badge source-badge-claude">CC</span>
                  <span className="capability-name">CLAUDE.md</span>
                  <span className="capability-detail">{inv.memory.claudeMd.firstLine}</span>
                  <span className="capability-meta">{kb(inv.memory.claudeMd.bytes)}</span>
                </div>
              )}
              {inv.memory.agentsMd && (
                <div className="capability-row">
                  <span className="source-badge source-badge-codex">CX</span>
                  <span className="capability-name">AGENTS.md</span>
                  <span className="capability-detail">{inv.memory.agentsMd.firstLine}</span>
                  <span className="capability-meta">{kb(inv.memory.agentsMd.bytes)}</span>
                </div>
              )}
              {!inv.memory.claudeMd && !inv.memory.agentsMd && (
                <div className="capability-empty">none</div>
              )}
            </div>

            <div className="capability-group">
              <div className="capability-group-title">Skills ({inv.skills.length})</div>
              {inv.skills.map((s) => (
                <div key={s.dir} className="capability-row" title={s.dir}>
                  {s.tools.map((t) => (
                    <span key={t} className={`source-badge source-badge-${t}`}>
                      {t === 'claude' ? 'CC' : 'CX'}
                    </span>
                  ))}
                  <span className="capability-name">{s.name}</span>
                  <span className="capability-detail">{s.description}</span>
                </div>
              ))}
              {inv.skills.length === 0 && <div className="capability-empty">none</div>}
            </div>

            <div className="capability-group">
              <div className="capability-group-title">Subagents ({inv.agents.length})</div>
              {inv.agents.map((a) => (
                <div key={a.path} className="capability-row" title={a.path}>
                  <span className="source-badge source-badge-claude">CC</span>
                  <span className="capability-name">{a.name}</span>
                  <span className="capability-detail">{a.description}</span>
                </div>
              ))}
              {inv.agents.length === 0 && <div className="capability-empty">none</div>}
            </div>

            <div className="capability-group">
              <div className="capability-group-title">MCP servers ({inv.mcp.length})</div>
              {inv.mcp.map((m) => (
                <div key={`${m.tool}:${m.name}`} className="capability-row">
                  <span className={`source-badge source-badge-${m.tool}`}>
                    {m.tool === 'claude' ? 'CC' : 'CX'}
                  </span>
                  <span className="capability-name">{m.name}</span>
                  <span className="capability-detail">{m.command}</span>
                  <span className="capability-meta">{m.scope}</span>
                </div>
              ))}
              {inv.mcp.length === 0 && <div className="capability-empty">none</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
