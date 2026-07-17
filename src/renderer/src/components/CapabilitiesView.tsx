import { useCallback, useEffect, useState } from 'react'
import type {
  AgentRef,
  CapabilityInventory,
  CopyDestination,
  CopyResult,
  SkillRef,
  Tool
} from '../../../shared/capabilities/types'
import type { Project } from '../../../shared/projects'

interface CapabilitiesViewProps {
  projects: Project[]
}

type CopySubject =
  | { kind: 'skill'; ref: SkillRef }
  | { kind: 'agent'; ref: AgentRef }

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
  const [copying, setCopying] = useState<CopySubject | null>(null)
  const [pickedTools, setPickedTools] = useState<Set<Tool>>(new Set(['claude']))
  const [pickedTargets, setPickedTargets] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const rescan = useCallback(() => {
    window.api
      .scanCapabilities(projects.map((p) => ({ id: p.id, name: p.name, path: p.path })))
      .then((result: CapabilityInventory[]) => setInventories(result))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [projects])

  useEffect(() => {
    rescan()
  }, [rescan])

  const startCopy = (subject: CopySubject): void => {
    setCopying(subject)
    setPickedTools(new Set(subject.kind === 'skill' ? subject.ref.tools : ['claude']))
    setPickedTargets(new Set())
    setBanner(null)
  }

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const buildDestinations = (): CopyDestination[] => {
    if (!copying) return []
    const tools: Tool[] = copying.kind === 'agent' ? ['claude'] : [...pickedTools]
    const dests: CopyDestination[] = []
    for (const target of pickedTargets) {
      for (const tool of tools) {
        if (target === 'personal') {
          dests.push({ kind: 'global', tool, label: 'Personal' })
        } else {
          const project = projects.find((p) => p.id === target)
          if (project) dests.push({ kind: 'project', path: project.path, tool, label: project.name })
        }
      }
    }
    return dests
  }

  const applyCopy = async (): Promise<void> => {
    if (!copying) return
    const destinations = buildDestinations()
    if (destinations.length === 0) return
    setBusy(true)
    try {
      const invoke = (dests: CopyDestination[], overwrite: boolean): Promise<CopyResult[]> =>
        copying.kind === 'skill'
          ? window.api.copySkill({ sourceDir: copying.ref.dir, destinations: dests, overwrite })
          : window.api.copyAgent({ sourcePath: copying.ref.path, destinations: dests, overwrite })

      let results = await invoke(destinations, false)

      const collisions = results.filter((r) => r.status === 'exists')
      if (collisions.length > 0) {
        const list = collisions.map((r) => `${r.dest.label} (${r.dest.tool})`).join(', ')
        if (window.confirm(`Already installed in: ${list}.\n\nOverwrite those copies?`)) {
          const forced = await invoke(collisions.map((r) => r.dest), true)
          results = results.filter((r) => r.status !== 'exists').concat(forced)
        }
      }

      const copied = results.filter((r) => r.status === 'copied').length
      const skipped = results.filter((r) => r.status === 'exists').length
      const errors = results.filter((r) => r.status === 'error')
      setBanner(
        `Copied to ${copied} destination${copied === 1 ? '' : 's'}` +
          (skipped ? `, ${skipped} skipped` : '') +
          (errors.length ? ` — ${errors.length} failed: ${errors[0].error}` : '') +
          '. Running sessions pick this up on their next start.'
      )
      setCopying(null)
      rescan()
    } catch (err) {
      setBanner(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="capabilities-view">
      <header className="capabilities-header">
        <h2>Capabilities</h2>
        <p className="capabilities-subtitle">
          What each scope gives your agents. Copy skills and subagents between projects and your
          personal setup — files are copied, never moved.
        </p>
        {banner && <div className="capabilities-banner">{banner}</div>}
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
                  <button
                    className="copy-to-button"
                    onClick={() => startCopy({ kind: 'skill', ref: s })}
                  >
                    Copy to…
                  </button>
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
                  <button
                    className="copy-to-button"
                    onClick={() => startCopy({ kind: 'agent', ref: a })}
                  >
                    Copy to…
                  </button>
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

      {copying && (
        <div className="copy-modal-backdrop" onClick={() => !busy && setCopying(null)}>
          <div className="copy-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="copy-modal-title">
              Copy {copying.kind === 'skill' ? 'skill' : 'subagent'} “{copying.ref.name}”
            </h3>

            {copying.kind === 'skill' ? (
              <div className="copy-modal-section">
                <div className="copy-modal-label">For which tool</div>
                {(['claude', 'codex'] as Tool[]).map((t) => (
                  <label key={t} className="copy-modal-option">
                    <input
                      type="checkbox"
                      checked={pickedTools.has(t)}
                      onChange={() => setPickedTools((s) => toggle(s, t))}
                    />
                    {t === 'claude' ? 'Claude Code (.claude/skills)' : 'Codex (.codex/skills)'}
                  </label>
                ))}
              </div>
            ) : (
              <div className="copy-modal-section">
                <div className="copy-modal-label">Subagents are Claude Code only (.claude/agents)</div>
              </div>
            )}

            <div className="copy-modal-section">
              <div className="copy-modal-label">Into</div>
              <label className="copy-modal-option">
                <input
                  type="checkbox"
                  checked={pickedTargets.has('personal')}
                  onChange={() => setPickedTargets((s) => toggle(s, 'personal'))}
                />
                Personal (all projects, globally)
              </label>
              {projects.map((p) => (
                <label key={p.id} className="copy-modal-option">
                  <input
                    type="checkbox"
                    checked={pickedTargets.has(p.id)}
                    onChange={() => setPickedTargets((s) => toggle(s, p.id))}
                  />
                  {p.name}
                </label>
              ))}
              {projects.length > 0 && (
                <button
                  className="copy-modal-selectall"
                  onClick={() => setPickedTargets(new Set(projects.map((p) => p.id)))}
                >
                  Select all projects
                </button>
              )}
            </div>

            <div className="copy-modal-actions">
              <button className="copy-modal-cancel" disabled={busy} onClick={() => setCopying(null)}>
                Cancel
              </button>
              <button
                className="copy-modal-apply"
                disabled={busy || pickedTargets.size === 0 || (copying.kind === 'skill' && pickedTools.size === 0)}
                onClick={() => void applyCopy()}
              >
                {busy ? 'Copying…' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
