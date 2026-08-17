import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { KeyRound, TriangleAlert, X } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { Button, IconButton } from './ui'
import {
  AgentRow,
  HookRow,
  InstructionsRow,
  McpRow,
  SkillRow,
  type MemoryKind
} from './capabilities/CapabilityRows'
import { MD_LINKS } from '../markdownLinks'
import type {
  AgentRef,
  CapabilityInventory,
  CopyDestination,
  CopyResult,
  FileRef,
  HookRef,
  McpRef,
  SkillRef,
  Tool
} from '../../../shared/capabilities/types'

/**
 * Tabs are by capability **type**, not by scope: the question this view exists
 * to answer is "which scopes have this?", and stacking all five types inside
 * every scope card made that a scrolling exercise across N projects.
 *
 * Counts are totals across every scope, so the strip doubles as the inventory
 * summary — including capabilities that are installed but unusable, which is
 * why the Skills count can exceed what any agent can actually reach.
 */
type CapabilityTab = 'instructions' | 'skills' | 'agents' | 'hooks' | 'mcp'

const TABS: Array<{
  id: CapabilityTab
  label: string
  count: (inv: CapabilityInventory[]) => number
}> = [
  {
    id: 'instructions',
    label: 'Instructions',
    count: (inv) =>
      inv.reduce((n, i) => n + (i.memory.claudeMd ? 1 : 0) + (i.memory.agentsMd ? 1 : 0), 0)
  },
  { id: 'skills', label: 'Skills', count: (inv) => inv.reduce((n, i) => n + i.skills.length, 0) },
  { id: 'agents', label: 'Agents', count: (inv) => inv.reduce((n, i) => n + i.agents.length, 0) },
  { id: 'hooks', label: 'Hooks', count: (inv) => inv.reduce((n, i) => n + i.hooks.length, 0) },
  { id: 'mcp', label: 'MCP', count: (inv) => inv.reduce((n, i) => n + i.mcp.length, 0) }
]
import type { Project } from '../../../shared/projects'

interface CapabilitiesViewProps {
  projects: Project[]
  onClose: () => void
}

type CopySubject =
  | { kind: 'skill'; ref: SkillRef }
  | { kind: 'agent'; ref: AgentRef }
  | { kind: 'memory'; ref: FileRef; file: MemoryKind }
  | { kind: 'mcp'; ref: McpRef }
  | { kind: 'hook'; ref: HookRef }

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

export function CapabilitiesView({ projects, onClose }: CapabilitiesViewProps): React.JSX.Element {
  const [inventories, setInventories] = useState<CapabilityInventory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copying, setCopying] = useState<CopySubject | null>(null)
  const [pickedTools, setPickedTools] = useState<Set<Tool>>(new Set(['claude']))
  const [pickedTargets, setPickedTargets] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ title: string; content: string } | null>(null)
  const [tab, setTab] = useState<CapabilityTab>('agents')

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

  /** Scopes that already have this exact hook (event+matcher+command) */
  const hookHolders = (ref: HookRef): Set<string> => {
    const holders = new Set<string>()
    for (const inv of inventories ?? []) {
      const has = inv.hooks.some(
        (h) => h.event === ref.event && h.matcher === ref.matcher && h.command === ref.command
      )
      if (!has) continue
      if (inv.scope.kind === 'project') holders.add(inv.scope.projectId)
      else if (inv.scope.tool === 'claude') holders.add('personal')
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
      copying.kind === 'agent' || copying.kind === 'hook'
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
              : copying.kind === 'hook'
                ? window.api.copyHook({ ref: copying.ref, destinations: dests })
                : window.api.copyMemory({ sourcePath: copying.ref.path, destinations: dests })

      let results = await invoke(destinations, false)

      // Memory files and hooks have no overwrite path — skills/agents/mcp confirm
      const collisions = results.filter((r) => r.status === 'exists')
      if (copying.kind !== 'memory' && copying.kind !== 'hook' && collisions.length > 0) {
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

  const tabs = TABS.map((t) => ({ ...t, count: t.count(inventories ?? []) }))

  return (
    <div className="capabilities-view">
      <header className="capabilities-header">
        <div className="capabilities-header-top">
          <h2>Capabilities</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={20} strokeWidth={1.75} />
          </IconButton>
        </div>
        <p className="capabilities-subtitle">
          What each scope gives your agents. Copy skills and subagents between projects and your
          personal setup — files are copied, never moved.
        </p>
        <nav className="capabilities-tabs" aria-label="Capability types">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`capabilities-tab${tab === t.id ? ' capabilities-tab--active' : ''}`}
              aria-current={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <span className="capabilities-tab__count">{t.count}</span>
            </button>
          ))}
        </nav>
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
              {tab === 'instructions' && (
                <>
                  {(
                    [
                      ['CLAUDE.md', inv.memory.claudeMd, 'claude'],
                      ['AGENTS.md', inv.memory.agentsMd, 'codex']
                    ] as Array<[MemoryKind, FileRef | undefined, Tool]>
                  ).map(
                    ([file, ref, tool]) =>
                      ref && (
                        <InstructionsRow
                          key={file}
                          file={file}
                          refFile={ref}
                          tool={tool}
                          onView={() => viewMemory(`${scopeTitle(inv)} — ${file}`, ref.path)}
                          onCopy={() => startCopy({ kind: 'memory', ref, file })}
                        />
                      )
                  )}
                  {!inv.memory.claudeMd && !inv.memory.agentsMd && (
                    <div className="capability-empty">none</div>
                  )}
                </>
              )}

              {tab === 'skills' && (
                <>
                  {inv.skills.map((s) => (
                    <SkillRow
                      key={s.dir}
                      skill={s}
                      onCopy={() => startCopy({ kind: 'skill', ref: s })}
                    />
                  ))}
                  {inv.skills.length === 0 && <div className="capability-empty">none</div>}
                </>
              )}

              {tab === 'agents' && (
                <>
                  {inv.agents.map((a) => (
                    <AgentRow
                      key={a.path}
                      agent={a}
                      onCopy={() => startCopy({ kind: 'agent', ref: a })}
                    />
                  ))}
                  {inv.agents.length === 0 && (
                    <div className="capability-empty">
                      {inv.scope.kind === 'global' && inv.scope.tool === 'codex'
                        ? 'not scanned yet — Codex subagents are TOML in ~/.codex/agents'
                        : 'none'}
                    </div>
                  )}
                </>
              )}

              {tab === 'hooks' && (
                <>
                  {inv.hooks.map((h, hi) => (
                    <HookRow key={hi} hook={h} onCopy={() => startCopy({ kind: 'hook', ref: h })} />
                  ))}
                  {inv.hooks.length === 0 && (
                    <div className="capability-empty">
                      {inv.scope.kind === 'global' && inv.scope.tool === 'codex'
                        ? 'plugin-managed in Codex'
                        : 'none'}
                    </div>
                  )}
                </>
              )}

              {tab === 'mcp' && (
                <>
                  {inv.mcp.map((m) => (
                    <McpRow
                      key={`${m.tool}:${m.name}`}
                      mcp={m}
                      onCopy={() => startCopy({ kind: 'mcp', ref: m })}
                    />
                  ))}
                  {inv.mcp.length === 0 && <div className="capability-empty">none</div>}
                </>
              )}
            </div>
          </section>
        ))}
      </div>

      {viewing && (
        <ModalShell title={viewing.title} size="wide" onClose={() => setViewing(null)}>
          <div className="memory-viewer-body message-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_LINKS}>
              {viewing.content}
            </ReactMarkdown>
          </div>
        </ModalShell>
      )}

      {copying && (
        <ModalShell
          title={
            <>
              Copy{' '}
              {copying.kind === 'skill'
                ? `skill “${copying.ref.name}”`
                : copying.kind === 'agent'
                  ? `subagent “${copying.ref.name}”`
                  : copying.kind === 'mcp'
                    ? `MCP server “${copying.ref.name}”`
                    : copying.kind === 'hook'
                      ? `hook ${copying.ref.event}${copying.ref.matcher ? ` · ${copying.ref.matcher}` : ''}`
                      : copying.file}
            </>
          }
          busy={busy}
          onClose={() => setCopying(null)}
          footer={
            <>
              <div className="wt-footer-spacer" />
              <Button intent="secondary" disabled={busy} onClick={() => setCopying(null)}>
                Cancel
              </Button>
              <Button
                intent="primary"
                loading={busy}
                loadingText="Copying…"
                disabled={
                  pickedTargets.size === 0 ||
                  (copying.kind === 'skill' && pickedTools.size === 0)
                }
                onClick={() => void applyCopy()}
              >
                Copy
              </Button>
            </>
          }
        >
          <>
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
            {copying.kind === 'hook' && (
              <div className="copy-modal-section">
                <div className="copy-modal-label">
                  <TriangleAlert
                    className="copy-modal-label-icon copy-modal-label-icon--warn"
                    size={14}
                    strokeWidth={1.75}
                  />
                  Hooks run automatically. This installs into .claude/settings.json:
                </div>
                <code className="hook-command-preview">{copying.ref.command}</code>
              </div>
            )}
            {copying.kind === 'mcp' && copying.ref.envKeys && copying.ref.envKeys.length > 0 && (
              <div className="copy-modal-section">
                <div className="copy-modal-label">
                  <KeyRound className="copy-modal-label-icon" size={14} strokeWidth={1.75} />
                  Secrets are never copied — set these env vars manually at each destination:{' '}
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
                      : copying.kind === 'hook'
                        ? hookHolders(copying.ref)
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
                      <Button
                        intent="ghost"
                        size="compact"
                        className="copy-modal-selectall"
                        onClick={() =>
                          setPickedTargets(
                            new Set(projects.map((p) => p.id).filter((id) => !holders.has(id)))
                          )
                        }
                      >
                        Select all projects
                      </Button>
                    )}
                  </>
                )
              })()}
            </div>
          </>
        </ModalShell>
      )}
    </div>
  )
}
