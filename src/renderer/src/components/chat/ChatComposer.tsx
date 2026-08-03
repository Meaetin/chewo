import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, FileText, GitBranch, Square, X } from 'lucide-react'
import { Badge, IconButton } from '../ui'
import { Select, type SelectOption } from '../Select'
import { EFFORT_LEVELS, type AgentModel, type EffortLevel } from '../../../../shared/agents'
import { countLines, isLongPaste, type Attachment } from '../../../../shared/attachments'
import type { ChatUsage } from '../../../../shared/agent-chat'
import { usageChips } from '../../chatUsage'
import { useAccountUsage } from './useAccountUsage'

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

/**
 * The conversation's two budgets, on one dim line under the pill. Outside the
 * box rather than inside it because these describe the session, not the message
 * being written — and below rather than above, so a growing input never pushes
 * them around mid-sentence.
 */
function UsageLine({ usage, busy }: { usage: ChatUsage; busy: boolean }): React.JSX.Element | null {
  const chips = usageChips(usage, useAccountUsage(busy))
  if (chips.length === 0) return null
  return (
    <div className="chat-usage">
      {chips.map((chip) => (
        <span
          key={chip.id}
          className={`chat-usage-chip chat-usage-chip--${chip.tone}`}
          title={chip.title}
        >
          {chip.fill !== undefined && (
            <span className="chat-usage-meter" aria-hidden="true">
              <span className="chat-usage-meter-fill" style={{ width: `${chip.fill * 100}%` }} />
            </span>
          )}
          {chip.text}
        </span>
      ))}
    </div>
  )
}

/** Read a pasted image file as a data URL + its base64 payload for staging. */
const readImage = (file: File): Promise<{ dataUrl: string; base64: string }> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve({ dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
    }
    reader.readAsDataURL(file)
  })

/**
 * One pasted item, sitting on top of the input inside the same pill. Hovering
 * reveals the X — the chips are usually just confirmation that the paste
 * landed, so the control that undoes it stays out of the way until wanted.
 */
function AttachmentChipView({
  attachment,
  onRemove
}: {
  attachment: Attachment
  onRemove: () => void
}): React.JSX.Element {
  const detail =
    attachment.kind === 'text'
      ? `${attachment.lines} ${attachment.lines === 1 ? 'line' : 'lines'}`
      : 'Image'

  return (
    <div
      className={`chat-attachment chat-attachment--${attachment.kind}`}
      // The whole point of folding it away is that it is too big to show, so
      // the hover gives back the opening of it rather than nothing
      title={attachment.kind === 'text' ? attachment.text?.slice(0, 600) : undefined}
    >
      {attachment.kind === 'image' && attachment.preview ? (
        <img className="chat-attachment-thumb" src={attachment.preview} alt="" />
      ) : (
        <span className="chat-attachment-icon">
          <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
        </span>
      )}
      <span className="chat-attachment-text">
        <span className="chat-attachment-label">{attachment.label}</span>
        <span className="chat-attachment-detail">{detail}</span>
      </span>
      <IconButton
        label={`Remove ${attachment.label}`}
        dense
        className="chat-attachment-remove"
        onClick={onRemove}
      >
        <X size={12} strokeWidth={2} />
      </IconButton>
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
  /** Context fullness and rate-limit window; empty until the first turn speaks */
  usage: ChatUsage
  onSend: (text: string, attachments: Attachment[]) => void
  onInterrupt: () => void
  /** A staging failure has nowhere else to surface from in here */
  onError?: (message: string) => void
}

export function ChatComposer({
  busy,
  disabled,
  slashCommands,
  placeholder,
  setup,
  usage,
  onSend,
  onInterrupt,
  onError
}: ChatComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
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

  /**
   * Chip numbering counts pastes, not surviving chips: removing "Image 1" must
   * not silently rename "Image 2" to it, or the label stops naming a thing.
   */
  const pasteSeq = useRef({ image: 0, text: 0 })

  /**
   * A paste becomes a chip in two cases and stays a plain paste otherwise: an
   * image, which has no textual form at all, and a block of text long enough
   * that inlining it would bury whatever the user is actually asking.
   */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (disabled) return
    const files = [...e.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)

    if (files.length > 0) {
      e.preventDefault()
      for (const file of files) {
        const label = `Image ${++pasteSeq.current.image}`
        void readImage(file)
          .then(async ({ dataUrl, base64 }) => {
            // Staged now rather than on send: the file is what every runtime
            // is fed from, and doing it here means the failure is visible
            // while the chip is still the thing the user is looking at
            const path = await window.api.stageAttachment(base64, file.type)
            setAttachments((prev) => [
              ...prev,
              { id: path, kind: 'image', label, path, preview: dataUrl }
            ])
          })
          .catch((err: unknown) => onError?.(`Could not attach the image: ${String(err)}`))
      }
      return
    }

    const text = e.clipboardData.getData('text/plain')
    if (!text || !isLongPaste(text)) return
    e.preventDefault()
    const n = ++pasteSeq.current.text
    setAttachments((prev) => [
      ...prev,
      { id: `text-${n}`, kind: 'text', label: `Pasted text ${n}`, text, lines: countLines(text) }
    ])
  }

  // An attachment alone is a complete message — "look at this" is a request.
  // The one exception is an unstarted pane, whose first message also names the
  // branch and decides the runtime; there, words are the point.
  const sendable = Boolean(value.trim()) || (attachments.length > 0 && !setup)

  const submit = (): void => {
    if (!sendable || disabled) return
    onSend(value.trim(), attachments)
    setValue('')
    setAttachments([])
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
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((a) => (
              <AttachmentChipView
                key={a.id}
                attachment={a}
                onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              />
            ))}
          </div>
        )}

        <div className="chat-composer-row">
          <textarea
            ref={areaRef}
            className="chat-composer-input"
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onPaste={onPaste}
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
              disabled={disabled || !sendable}
              onClick={submit}
            >
              <ArrowUp size={16} strokeWidth={2} />
            </IconButton>
          )}
        </div>

        {setup && <SessionSetupRow setup={setup} />}
      </div>

      <UsageLine usage={usage} busy={busy} />
    </div>
  )
}
