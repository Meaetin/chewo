import { KeyRound } from 'lucide-react'
import { Badge, Button, Row, Tooltip } from '../ui'
import type {
  AgentRef,
  CapabilityOrigin,
  FileRef,
  HookRef,
  McpRef,
  SkillRef,
  Tool
} from '../../../../shared/capabilities/types'

/**
 * One row treatment per capability type, extracted from `CapabilitiesView` so
 * the view itself is a shell (tabs, scopes, copy modal) rather than a file
 * that renders five list formats inline.
 *
 * These are presentational: every action arrives as a callback, so the view
 * keeps sole ownership of the copy flow and its confirmations.
 */

export type MemoryKind = 'CLAUDE.md' | 'AGENTS.md'

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * Where a definition came from, when that is not simply "this scope".
 *
 * A disabled plugin is the case worth drawing: its skills and agents are
 * installed and inventoried, but reach no agent at all, so a row that looked
 * ordinary would explain nothing when the agent that wants it comes up empty.
 */
export function OriginTag({ origin }: { origin: CapabilityOrigin }): React.JSX.Element | null {
  if (origin.kind !== 'plugin') return null
  return (
    <span className="capability-origin">
      {origin.plugin}
      {!origin.enabled && <span className="capability-origin__off">disabled</span>}
    </span>
  )
}

const isOff = (origin: CapabilityOrigin): boolean =>
  origin.kind === 'plugin' && !origin.enabled

const offTitle = (origin: CapabilityOrigin, what: string): string | undefined =>
  isOff(origin) && origin.kind === 'plugin'
    ? `Installed by the ${origin.plugin} plugin, which is disabled — no agent can use this ${what}. Enable it with: claude plugin enable ${origin.plugin}@${origin.marketplace}`
    : undefined

const rowClass = (origin: CapabilityOrigin, extra = ''): string =>
  `capability-row${isOff(origin) ? ' capability-row--off' : ''}${extra ? ` ${extra}` : ''}`

export function InstructionsRow({
  file,
  refFile,
  tool,
  onView,
  onCopy
}: {
  file: MemoryKind
  refFile: FileRef
  tool: Tool
  onView: () => void
  onCopy: () => void
}): React.JSX.Element {
  return (
    <Row
      className="capability-row capability-row--clickable"
      density="compact"
      leading={<Badge source={tool} />}
      onClick={onView}
      trailing={
        <>
          <Button
            intent="secondary"
            size="compact"
            onClick={(e) => {
              e.stopPropagation()
              onView()
            }}
          >
            View
          </Button>
          <Button
            intent="secondary"
            size="compact"
            onClick={(e) => {
              e.stopPropagation()
              onCopy()
            }}
          >
            Copy to…
          </Button>
        </>
      }
    >
      <div className="capability-row__main">
        <span className="capability-name">{file}</span>
        <span className="capability-detail">{refFile.firstLine}</span>
      </div>
      <span className="capability-meta">{kb(refFile.bytes)}</span>
    </Row>
  )
}

export function SkillRow({
  skill,
  onCopy
}: {
  skill: SkillRef
  onCopy: () => void
}): React.JSX.Element {
  return (
    <Row
      className={rowClass(skill.origin)}
      density="compact"
      title={offTitle(skill.origin, 'skill')}
      leading={skill.tools.map((t) => (
        <Badge key={t} source={t} />
      ))}
      trailing={
        // A plugin's files belong to its plugin manager, not to us
        // (SPEC-CAPABILITIES §4.4) — shown and attachable, never copied.
        skill.origin.kind === 'plugin' ? null : (
          <Button intent="secondary" size="compact" onClick={onCopy}>
            Copy to…
          </Button>
        )
      }
    >
      <div className="capability-row__main">
        <span className="capability-name">{skill.name}</span>
        <span className="capability-detail">{skill.description}</span>
      </div>
      <OriginTag origin={skill.origin} />
    </Row>
  )
}

/**
 * `tools` empty means "inherits every tool", which is the opposite of "none" —
 * so an empty allowlist must never render as a restriction.
 */
export function toolPolicy(agent: AgentRef): string {
  const parts: string[] = []
  if (agent.tools.length > 0) parts.push(agent.tools.join(', '))
  else parts.push('all tools')
  if (agent.disallowedTools.length > 0) parts.push(`except ${agent.disallowedTools.join(', ')}`)
  return parts.join(' · ')
}

export function AgentRow({
  agent,
  onCopy,
  onEdit
}: {
  agent: AgentRef
  onCopy: () => void
  /** Absent for a plugin's agent — its files belong to its plugin manager */
  onEdit?: () => void
}): React.JSX.Element {
  const fromPlugin = agent.origin.kind === 'plugin'
  return (
    <Row
      className={rowClass(agent.origin)}
      density="compact"
      title={offTitle(agent.origin, 'agent')}
      leading={<Badge source="claude" />}
      trailing={
        fromPlugin ? null : (
          <>
            {onEdit && (
              <Button intent="secondary" size="compact" onClick={onEdit}>
                Edit
              </Button>
            )}
            <Button intent="secondary" size="compact" onClick={onCopy}>
              Copy to…
            </Button>
          </>
        )
      }
    >
      <div className="capability-row__main capability-row__main--stacked">
        {/* The description is the router — it is what the main agent reads to
            decide whether to delegate, so it gets a line to itself rather than
            competing with the model/tools summary for one row's width. */}
        <div className="capability-row__line">
          <span className="capability-name">{agent.name}</span>
          <span className="capability-detail">{agent.description}</span>
        </div>
        <span className="capability-subdetail">
          {agent.model ?? 'inherit'}
          {agent.effort ? ` · ${agent.effort}` : ''} · {toolPolicy(agent)}
          {agent.skills.length > 0 && ` · preloads ${agent.skills.join(', ')}`}
        </span>
      </div>
      <OriginTag origin={agent.origin} />
    </Row>
  )
}

export function HookRow({
  hook,
  onCopy
}: {
  hook: HookRef
  onCopy: () => void
}): React.JSX.Element {
  return (
    <Row
      className="capability-row"
      density="compact"
      leading={<Badge source="claude" />}
      trailing={
        <Button intent="secondary" size="compact" onClick={onCopy}>
          Copy to…
        </Button>
      }
    >
      <div className="capability-row__main">
        <span className="capability-name">
          {hook.event}
          {hook.matcher ? ` · ${hook.matcher}` : ''}
        </span>
        <span className="capability-detail">
          <code>{hook.command}</code>
        </span>
      </div>
    </Row>
  )
}

export function McpRow({
  mcp,
  onCopy
}: {
  mcp: McpRef
  onCopy: () => void
}): React.JSX.Element {
  return (
    <Row
      className="capability-row"
      density="compact"
      leading={<Badge source={mcp.tool} />}
      trailing={
        <Button intent="secondary" size="compact" onClick={onCopy}>
          Copy to…
        </Button>
      }
    >
      <div className="capability-row__main">
        <span className="capability-name">{mcp.name}</span>
        <span className="capability-detail">{mcp.command}</span>
      </div>
      {mcp.envKeys && mcp.envKeys.length > 0 && (
        <span className="capability-meta capability-meta--keys">
          <Tooltip label={`Needs env vars: ${mcp.envKeys.join(', ')}`}>
            <KeyRound size={12} strokeWidth={1.75} />
          </Tooltip>
          {mcp.envKeys.length}
        </span>
      )}
      <span className="capability-meta">{mcp.scope}</span>
    </Row>
  )
}
