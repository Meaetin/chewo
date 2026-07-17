import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AgentRef,
  CapabilityInventory,
  CopyDestination,
  CopyResult,
  FileRef,
  McpRef,
  SkillRef,
  Tool
} from '../../../shared/capabilities/types'
import type { Project } from '../../../shared/projects'

interface CapabilitiesViewProps {
  projects: Project[]
}

type MemoryKind = 'CLAUDE.md' | 'AGENTS.md'

type CopySubject =
  | { kind: 'skill'; ref: SkillRef }
  | { kind: 'agent'; ref: AgentRef }
  | { kind: 'memory'; ref: FileRef; file: MemoryKind }
  | { kind: 'mcp'; ref: McpRef }

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
  const [viewing, setViewing] = useState<{ title: string; content: string } | null>(null)

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

  const viewMemory = (title: string, path: string): void => {
    window.api
      .readMemory(path)
      .then((content) => setViewing({ title, content }))
      .catch((err: unknown) =>
        setBanner(`Could not read file: ${err instanceof Error ? err.message : String(err)}`)
      )
  }

  /** Which scopes already have this memory file (disabled in the picker) */
  const memoryHolders = (file: MemoryKind): Set<string> => {
    const holders = new Set<string>()
    for (const inv of inventories ?? []) {
      const has = file === 'CLAUDE.md' ? inv.memory.claudeMd : inv.memory.agentsMd
      if (!has) continue
      if (inv.scope.kind === 'project') holders.add(inv.scope.projectId)
      else holders.add('personal')
    }
    return holders
  }

  /** Scopes already running a server with this name */
  const mcpHolders = (name: string): Set<string> => {
    const holders = new Set<string>()
    for (const inv of inventories ?? []) {
      if (!inv.mcp.some((m) => m.name === name)) continue
      if (inv.scope.kind === 'project') holders.add(inv.scope.projectId)
      else holders.add(inv.scope.tool === 'claude' ? 'personal-claude' : 'personal-codex')
    }
    return holders
  }

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const buildDestinations = (): CopyDestination[] => {
    if (!copying) return []
    if (copying.kind === 'mcp') {
      // MCP targets carry their tool in the key — projects are Claude-only
      const dests: CopyDestination[] = []
      for (const target of pickedTargets) {
        if (target === 'personal-claude') dests.push({ kind: 'global', tool: 'claude', label: 'Personal · Claude' })
        else if (target === 'personal-codex') dests.push({ kind: 'global', tool: 'codex', label: 'Personal · Codex' })
        else {
          const project = projects.find((p) => p.id === target)
          if (project) dests.push({ kind: 'project', path: project.path, tool: 'claude', label: project.name })
        }
      }
      return dests
    }
    const tools: Tool[] =
      copying.kind === 'agent'
        ? ['claude']
        : copying.kind === 'memory'
          ? [copying.file === 'CLAUDE.md' ? 'claude' : 'codex']
          : [...pickedTools]
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
          : copying.kind === 'agent'
            ? window.api.copyAgent({ sourcePath: copying.ref.path, destinations: dests, overwrite })
            : copying.kind === 'mcp'
              ? window.api.copyMcp({ ref: copying.ref, destinations: dests, overwrite })
              : window.api.copyMemory({ sourcePath: copying.ref.path, destinations: dests })

      let results = await invoke(destinations, false)

      // Memory files have no overwrite path by design — skills/agents confirm
      const collisions = results.filter((r) => r.status === 'exists')
      if (copying.kind !== 'memory' && collisions.length > 0) {
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
          (skipped ? `, ${skipped} skipped (already have one)` : '') +
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
              {(
                [
                  ['CLAUDE.md', inv.memory.claudeMd, 'claude'],
                  ['AGENTS.md', inv.memory.agentsMd, 'codex']
                ] as Array<[MemoryKind, FileRef | undefined, Tool]>
              ).map(
                ([file, ref, tool]) =>
                  ref && (
                    <div
                      key={file}
                      className="capability-row capability-row-clickable"
                      title="Click to view"
                      onClick={() => viewMemory(`${scopeTitle(inv)} — ${file}`, ref.path)}
                    >
                      <span className={`source-badge source-badge-${tool}`}>
                        {tool === 'claude' ? 'CC' : 'CX'}
                      </span>
                      <span className="capability-name">{file}</span>
                      <span className="capability-detail">{ref.firstLine}</span>
                      <button
                        className="copy-to-button"
                        onClick={(e) => {
                          e.stopPropagation()
                          viewMemory(`${scopeTitle(inv)} — ${file}`, ref.path)
                        }}
                      >
                        View
                      </button>
                      <button
                        className="copy-to-button copy-to-button-second"
                        onClick={(e) => {
                          e.stopPropagation()
                          startCopy({ kind: 'memory', ref, file })
                        }}
                      >
                        Copy to…
                      </button>
                      <span className="capability-meta">{kb(ref.bytes)}</span>
                    </div>
                  )
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
                  {m.envKeys && m.envKeys.length > 0 && (
                    <span className="capability-meta" title={`Needs env vars: ${m.envKeys.join(', ')}`}>
                      🔑{m.envKeys.length}
                    </span>
                  )}
                  <button className="copy-to-button" onClick={() => startCopy({ kind: 'mcp', ref: m })}>
                    Copy to…
                  </button>
                  <span className="capability-meta">{m.scope}</span>
                </div>
              ))}
              {inv.mcp.length === 0 && <div className="capability-empty">none</div>}
            </div>
          </section>
        ))}
      </div>

      {viewing && (
        <div className="copy-modal-backdrop" onClick={() => setViewing(null)}>
          <div className="memory-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="memory-viewer-header">
              <h3 className="copy-modal-title">{viewing.title}</h3>
              <button className="terminal-tab-close" onClick={() => setViewing(null)}>
                ×
              </button>
            </div>
            <div className="memory-viewer-body message-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{viewing.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      {copying && (
        <div className="copy-modal-backdrop" onClick={() => !busy && setCopying(null)}>
          <div className="copy-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="copy-modal-title">
              Copy{' '}
              {copying.kind === 'skill'
                ? `skill “${copying.ref.name}”`
                : copying.kind === 'agent'
                  ? `subagent “${copying.ref.name}”`
                  : copying.kind === 'mcp'
                    ? `MCP server “${copying.ref.name}”`
                    : copying.file}
            </h3>

            {copying.kind === 'skill' && (
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
            )}
            {copying.kind === 'agent' && (
              <div className="copy-modal-section">
                <div className="copy-modal-label">Subagents are Claude Code only (.claude/agents)</div>
              </div>
            )}
            {copying.kind === 'memory' && (
              <div className="copy-modal-section">
                <div className="copy-modal-label">
                  Whole-file duplicate — only to scopes without one. Existing files are never touched.
                </div>
              </div>
            )}
            {copying.kind === 'mcp' && copying.ref.envKeys && copying.ref.envKeys.length > 0 && (
              <div className="copy-modal-section">
                <div className="copy-modal-label">
                  🔑 Secrets are never copied — set these env vars manually at each destination:{' '}
                  {copying.ref.envKeys.join(', ')}
                </div>
              </div>
            )}

            <div className="copy-modal-section">
              <div className="copy-modal-label">Into</div>
              {(() => {
                const holders =
                  copying.kind === 'memory'
                    ? memoryHolders(copying.file)
                    : copying.kind === 'mcp'
                      ? mcpHolders(copying.ref.name)
                      : new Set<string>()
                const option = (key: string, text: string, note?: string): React.JSX.Element => {
                  const disabled = holders.has(key) || !!note
                  return (
                    <label key={key} className={`copy-modal-option ${disabled ? 'copy-modal-option-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={pickedTargets.has(key)}
                        onChange={() => setPickedTargets((s) => toggle(s, key))}
                      />
                      {text}
                      {holders.has(key) && <span className="copy-modal-has-one">already has one</span>}
                      {note && !holders.has(key) && <span className="copy-modal-has-one">{note}</span>}
                    </label>
                  )
                }
                if (copying.kind === 'mcp') {
                  const urlOnly = !!copying.ref.raw?.url && !copying.ref.raw?.command
                  return (
                    <>
                      {option('personal-claude', 'Personal · Claude Code')}
                      {option('personal-codex', 'Personal · Codex (global)', urlOnly ? 'URL servers unsupported' : undefined)}
                      {projects.map((p) => option(p.id, `${p.name} (Claude, .mcp.json)`))}
                    </>
                  )
                }
                return (
                  <>
                    {option('personal', 'Personal (all projects, globally)')}
                    {projects.map((p) => option(p.id, p.name))}
                    {projects.length > 0 && (
                      <button
                        className="copy-modal-selectall"
                        onClick={() =>
                          setPickedTargets(
                            new Set(projects.map((p) => p.id).filter((id) => !holders.has(id)))
                          )
                        }
                      >
                        Select all projects
                      </button>
                    )}
                  </>
                )
              })()}
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
