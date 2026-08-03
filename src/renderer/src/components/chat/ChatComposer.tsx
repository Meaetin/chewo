import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, GitBranch, Square } from 'lucide-react'
import { Badge, IconButton } from '../ui'
import { Select, type SelectOption } from '../Select'
import { EFFORT_LEVELS, type AgentModel, type EffortLevel } from '../../../../shared/agents'

/**
 * The two questions a session has to answer before it exists, asked here
 * rather than in a menu before the pane opens.
 *
 * Both are only answerable once you know the task: the branch is *named* after
 * it, and a Codex session has no composer of its own to take a first message
 * from. So the pane opens undecided, the task gets typed, and sending settles
 * both at once. After that they are gone — moving a live agent between
 * checkouts is a different, manual act.
 */
export interface SessionSetup {
  source: 'claude' | 'codex'
  isolate: boolean
  /** The chosen agent's catalog; empty until discovery returns */
  models: AgentModel[]
  /** Resolved model id — never the raw choice, so the label matches the spawn */
  model: string
  /** Resolved effort, already clamped to what this model accepts */
  effort: EffortLevel
  /** Absent in Home — no repo, so nothing to cut a branch from */
  projectName?: string
  /** `origin/main`; null when the repo can't say (no remote, or a bare init) */
  base: string | null
  /** The shared checkout's branch — what "this checkout" concretely means */
  currentBranch?: string
  onChange: (patch: Partial<SessionChoice>) => void
}

export interface SessionChoice {
  source: 'claude' | 'codex'
  isolate: boolean
  model: string
  effort: EffortLevel
}

const AGENTS = [
  { source: 'claude', label: 'Claude' },
  { source: 'codex', label: 'Codex' }
] as const

const title = (s: string): string => s[0].toUpperCase() + s.slice(1)

function SessionSetupRow({ setup }: { setup: SessionSetup }): React.JSX.Element {
  const { source, isolate, models, model, effort, base, projectName, currentBranch, onChange } =
    setup

  const selected = models.find((m) => m.id === model)
  const modelOptions: SelectOption<string>[] = models.map((m) => ({
    value: m.id,
    label: m.label,
    detail: m.detail
  }))
  // A resolved model the catalog doesn't list (offline discovery, or a CLI
  // update that dropped it) still has to show as itself — never as another row
  if (model && !selected) modelOptions.unshift({ value: model, label: model })
  // Codex with no catalog and no alias to fall back on: nothing is passed, so
  // the user's own config.toml default runs. Say that rather than show a blank.
  if (!model) modelOptions.unshift({ value: '', label: 'CLI default' })

  const effortOptions: SelectOption<string>[] = (selected?.efforts ?? EFFORT_LEVELS).map((e) => ({
    value: e,
    label: title(e)
  }))

  return (
    <div className="chat-setup">
      <div className="chat-setup-agents" role="radiogroup" aria-label="Agent">
        {AGENTS.map((a) => (
          <button
            key={a.source}
            type="button"
            role="radio"
            aria-checked={source === a.source}
            className={`chat-setup-chip${source === a.source ? ' chat-setup-chip--on' : ''}`}
            onClick={() => onChange({ source: a.source })}
          >
            <Badge source={a.source} />
            {a.label}
          </button>
        ))}
      </div>

      <Select
        className="chat-setup-select"
        menuMinWidth={260}
        value={model}
        options={modelOptions}
        onChange={(next) => onChange({ model: next })}
      />
      <Select
        className="chat-setup-select chat-setup-select--effort"
        menuMinWidth={160}
        value={effort}
        options={effortOptions}
        onChange={(next) => onChange({ effort: next })}
      />

      {projectName && (
        <button
          type="button"
          role="switch"
          aria-checked={isolate}
          className="chat-setup-branch"
          title={
            isolate
              ? `Cut from ${base ?? 'the default branch'}, so this session starts current — and Ship only ever sees its own work.`
              : 'Sees your uncommitted changes, but Ship here stages every agent\u2019s work at once.'
          }
          onClick={() => onChange({ isolate: !isolate })}
        >
          <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="chat-setup-branch-text">
            {isolate
              ? `Its own branch, from ${base ?? 'the default branch'}`
              : `${projectName}${currentBranch ? ` \u00b7 ${currentBranch}` : ''}`}
          </span>
          <span className="chat-setup-switch" data-on={isolate} />
        </button>
      )}
    </div>
  )
}

interface ChatComposerProps {
  busy: boolean
  disabled: boolean
  /** Names only, no leading slash */
  slashCommands: string[]
  placeholder: string
  /** Only while the session is unstarted — the agent and checkout pickers */
  setup?: SessionSetup
  onSend: (text: string) => void
  onInterrupt: () => void
}

export function ChatComposer({
  busy,
  disabled,
  slashCommands,
  placeholder,
  setup,
  onSend,
  onInterrupt
}: ChatComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // Grow with the content, up to a cap — a fixed single line makes pasting a
  // stack trace feel like a mistake
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 240)}px`
  }, [value])

  // Only a `/` in the very first column opens the palette; a path like
  // src/main/ inside a sentence must not.
  const query = /^\/(\S*)$/.exec(value)?.[1]
  const matches = useMemo(() => {
    if (query === undefined) return []
    const q = query.toLowerCase()
    return slashCommands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 8)
  }, [query, slashCommands])

  useEffect(() => setPaletteIndex(0), [query])

  const paletteOpen = matches.length > 0

  const submit = (): void => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
  }

  const accept = (name: string): void => {
    setValue(`/${name} `)
    areaRef.current?.focus()
  }

  return (
    <div className="chat-composer">
      {paletteOpen && (
        <div className="chat-palette">
          {matches.map((name, i) => (
            <button
              key={name}
              className={`chat-palette-item${i === paletteIndex ? ' chat-palette-item--active' : ''}`}
              onMouseEnter={() => setPaletteIndex(i)}
              onClick={() => accept(name)}
            >
              <code>/{name}</code>
            </button>
          ))}
        </div>
      )}

      {/* One box. The setup controls belong to the message being written, so
          they sit inside the same border rather than floating above it. */}
      <div className="chat-composer-box">
        <div className="chat-composer-row">
          <textarea
            ref={areaRef}
            className="chat-composer-input"
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (paletteOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setPaletteIndex((i) => (i + 1) % matches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setPaletteIndex((i) => (i - 1 + matches.length) % matches.length)
                  return
                }
                // Tab completes the name; Enter still sends, so a fully typed
                // command is not held hostage by an open palette
                if (e.key === 'Tab') {
                  e.preventDefault()
                  accept(matches[paletteIndex])
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {busy ? (
            <IconButton label="Stop (Esc)" className="chat-stop" onClick={onInterrupt}>
              <Square size={14} strokeWidth={2} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton
              label="Send (\u21b5)"
              className="chat-send"
              disabled={disabled || !value.trim()}
              onClick={submit}
            >
              <ArrowUp size={16} strokeWidth={2} />
            </IconButton>
          )}
        </div>

        {setup && <SessionSetupRow setup={setup} />}
      </div>
    </div>
  )
}
