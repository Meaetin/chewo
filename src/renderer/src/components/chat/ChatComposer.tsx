import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, FileText, GitBranch, Mic, Square, X } from 'lucide-react'
import { Badge, IconButton } from '../ui'
import { Select, type SelectOption } from '../Select'
import { EFFORT_LEVELS, type AgentModel, type EffortLevel } from '../../../../shared/agents'
import { countLines, isLongPaste, type Attachment } from '../../../../shared/attachments'
import type { ChatUsage } from '../../../../shared/agent-chat'
import { usageChips } from '../../chatUsage'
import { useAccountUsage } from './useAccountUsage'
import { useDictation } from './useDictation'
import { mentionAt } from '../../mentionMatch'
import { filterOptions } from '../../selectFilter'
import { joinDictated } from '../../dictation'

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
  /**
   * The CLI is running: the agent and the checkout are facts now, but the
   * model and the effort are not — both CLIs take a change mid-conversation,
   * so the row stays and loses only the questions that have been answered for
   * good.
   */
  started?: boolean
  isolate: boolean
  /** The chosen agent's catalog; empty until discovery returns */
  models: AgentModel[]
  /**
   * Resolved model id — never the raw choice, so the label matches the spawn.
   * On a running session it is instead what that session is *on*, and `''`
   * when nothing knows yet, which shows as the CLI's own default.
   */
  model: string
  /** Resolved effort, already clamped to what this model accepts. `''` on a
   *  running session that spawned without an effort flag — nothing reports it
   *  back, so the row says the CLI is deciding rather than guessing a level. */
  effort: EffortLevel | ''
  /** Absent in Home — no repo, so nothing to cut a branch from */
  projectName?: string
  /** `origin/main`; null when the repo can't say (no remote, or a bare init) */
  base: string | null
  /**
   * The start point the user picked instead. Absent means `base`, which is
   * deliberately not the same thing as picking it by name: leaving it alone
   * fetches first and prefers whichever of `origin/main` and local `main` is
   * ahead, and that resolution only happens at the moment the branch is cut.
   */
  baseChoice?: string
  /** Every other branch that could be the start point; absent while reading */
  branches?: { current: string; local: string[]; remote: string[] }
  /** The shared checkout's branch — what "this checkout" concretely means */
  currentBranch?: string
  /** Uncommitted files in that checkout — same count the git panel badge shows */
  currentDirty?: number
  /** Run as a lead that plans and dispatches to your subagents */
  orchestrate: boolean
  /**
   * How many agents this session could dispatch to. Zero hides the toggle
   * entirely — a control whose only effect is to brief a lead about an empty
   * roster is a control that does nothing.
   */
  dispatchable: number
  onChange: (patch: Partial<SessionChoice>) => void
}

export interface SessionChoice {
  source: 'claude' | 'codex'
  isolate: boolean
  orchestrate: boolean
  model: string
  effort: EffortLevel
  /** Empty string means "the default, resolved when the branch is cut" */
  base: string
}

const AGENTS = [
  { source: 'claude', label: 'Claude' },
  { source: 'codex', label: 'Codex' }
] as const

const title = (s: string): string => s[0].toUpperCase() + s.slice(1)

/**
 * "Stay in the project's checkout" as a picker value. `:` is one of the
 * characters git forbids in a ref name, so this can never collide with a
 * branch — which the empty string, already meaning "the default start point",
 * could not have been asked to do twice.
 */
const HERE = ':current'

/**
 * The heading over every row but the first. It carries the verb the rows
 * themselves cannot: `main` in this list does not mean "check out main", it
 * means "cut this session's scratch branch from main" — which is the one thing
 * about this control nobody could work out by reading it.
 */
const NEW_BRANCH = 'New branch from…'

/** Same two descriptions the switch used to show on hover, read up front now */
const LEAD_OPTIONS = (dispatchable: number): SelectOption<'agent' | 'lead'>[] => [
  { value: 'agent', label: 'Agent', detail: 'Runs as one agent, handling everything itself.' },
  {
    value: 'lead',
    label: `Lead · ${dispatchable} subagent${dispatchable === 1 ? '' : 's'}`,
    detail:
      'Plans the work into tasks and hands them to your subagents, showing who is doing what. Best for work that splits up; a single edit is faster done directly.'
  }
]

function SessionSetupRow({
  setup,
  busy
}: {
  setup: SessionSetup
  busy: boolean
}): React.JSX.Element {
  const {
    source,
    started = false,
    isolate,
    models,
    model,
    effort,
    base,
    baseChoice,
    branches,
    projectName,
    currentBranch,
    currentDirty,
    orchestrate,
    dispatchable,
    onChange
  } = setup

  const selected = models.find((m) => m.id === model)
  const modelOptions: SelectOption<string>[] = models.map((m) => ({
    value: m.id,
    label: m.label,
    detail: m.detail
  }))
  // A resolved model the catalog doesn't list (offline discovery, or a CLI
  // update that dropped it) still has to show as itself — never as another row
  if (model && !selected) modelOptions.unshift({ value: model, label: model })
  // Nothing is passed, so the CLI's own default runs — Codex with no catalog
  // and no alias to fall back on, or a session resumed from the sidebar, which
  // spawns with no model flag and says nothing about itself until its first
  // turn. Named rather than blank, and named for the thing it sets: this row
  // sits beside the effort one, which has the same story to tell.
  if (!model) modelOptions.unshift({ value: '', label: 'Default model' })

  const effortOptions: SelectOption<string>[] = (selected?.efforts ?? EFFORT_LEVELS).map((e) => ({
    value: e,
    label: title(e)
  }))
  // A session resumed from the sidebar spawned with no effort flag, and
  // neither CLI reports the one it settled on — so the row says the CLI is
  // deciding rather than naming a level we would only be guessing at.
  if (!effort) effortOptions.unshift({ value: '', label: 'Default effort' })

  /**
   * Both CLIs take a change mid-conversation, but neither wants one arriving
   * mid-turn: Claude's `/effort` would queue behind the work in flight, and
   * Codex reads the override off the *next* turn, which is the one being
   * spoken. So the pickers rest while the agent is talking.
   */
  const locked = started && busy
  const lockedWhy = locked ? 'Wait for this turn to finish' : undefined

  /**
   * Which branch this work is for — one question, where there used to be a
   * toggle and a picker asking two halves of it.
   *
   * Every row but the first cuts a scratch branch from what you picked. That
   * is not an implementation detail that could be traded for checking the
   * branch out directly: `git worktree add` refuses a branch that is already
   * checked out somewhere, so sessions would collide the moment two agents
   * were pointed at the same branch — the normal case here. Whether the work
   * comes back as a PR into that branch or goes straight onto it is Ship's
   * question, asked when the diff is visible.
   *
   * The default row carries no ref of its own: picking `origin/main` by name
   * and leaving the default alone are still different acts, since only the
   * latter falls back to local `main` when it holds commits the remote has not
   * seen. (Both fetch — a chosen base is refreshed at cut time too.) So the ref
   * it resolves to is filtered out of the lists below rather than offered twice
   * under one name.
   */
  const workOptions: SelectOption<string>[] = [
    {
      value: HERE,
      group: 'In this checkout',
      label: `${projectName ?? 'This checkout'}${currentBranch ? ` · ${currentBranch}` : ''}`,
      // Whichever is more useful right now: a dirty checkout says how much is
      // sitting there uncommitted, a clean one explains what "shared" costs.
      detail: currentDirty
        ? `Uncommitted · ${currentDirty} file${currentDirty === 1 ? '' : 's'}`
        : 'shared — other agents write here too'
    },
    { value: '', group: NEW_BRANCH, label: base ?? 'the default branch', detail: 'default' },
    ...(branches?.local ?? [])
      .filter((b) => b !== base)
      .map((b) => ({
        value: b,
        group: NEW_BRANCH,
        label: b,
        ...(b === branches?.current && { detail: 'checked out' })
      })),
    ...(branches?.remote ?? [])
      .filter((b) => b !== base)
      .map((b) => ({ value: b, group: NEW_BRANCH, label: b, detail: 'remote' }))
  ]
  // A pick made before the list arrived — or one whose ref has since been
  // deleted — still has to show as itself, and stay reachable in the menu so
  // there is a way back to the default. It is only called out as missing once
  // a list has actually been read.
  if (baseChoice && !workOptions.some((o) => o.value === baseChoice))
    workOptions.splice(2, 0, {
      value: baseChoice,
      // Same group as its neighbours, or the heading would draw again below it
      group: NEW_BRANCH,
      label: baseChoice,
      ...(branches && { detail: 'not found' })
    })

  return (
    <div className="chat-setup">
      {started ? (
        // Which CLI is running is settled by the process, not by a control —
        // switching agents means a different conversation, which is a new
        // session rather than a picker.
        <span
          className="chat-setup-chip chat-setup-chip--static"
          title="The agent is fixed once the session starts"
        >
          <Badge source={source} />
          {AGENTS.find((a) => a.source === source)?.label}
        </span>
      ) : (
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
      )}

      <Select
        className="chat-setup-select"
        menuMinWidth={260}
        value={model}
        options={modelOptions}
        disabled={locked}
        title={lockedWhy}
        onChange={(next) => onChange({ model: next })}
      />
      <Select
        className="chat-setup-select chat-setup-select--effort"
        menuMinWidth={160}
        value={effort}
        options={effortOptions}
        disabled={locked}
        title={lockedWhy}
        onChange={(next) => onChange({ effort: next })}
      />

      {projectName && !started && (
        <div
          className="chat-setup-branch"
          title={
            isolate
              ? `Work for ${baseChoice || base || 'the default branch'} — this session gets a scratch branch cut from it, and Ship decides whether that comes back as a pull request or goes straight on.`
              : 'Runs in the project checkout. Sees your uncommitted changes, but Ship here stages every agent’s work at once.'
          }
        >
          <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
          {/* One control, because it is one question. The switch and the base
              picker that used to sit here asked "isolate?" and "from where?",
              which are two halves of the same thing — the first row is the off
              state, and picking any branch is what turns isolation on. */}
          <Select
            className="chat-setup-select chat-setup-base"
            menuMinWidth={300}
            searchable
            searchPlaceholder="Filter branches…"
            value={isolate ? (baseChoice ?? '') : HERE}
            options={workOptions}
            onChange={(next) =>
              next === HERE ? onChange({ isolate: false }) : onChange({ isolate: true, base: next })
            }
          />
        </div>
      )}

      {/* Spawn-time, like everything else on this row: the brief goes in with
          `--append-system-prompt`, so it cannot be turned on mid-session.
          Deliberately off by default — delegation costs a fresh context that
          cannot see this conversation, which is a bad trade for the small
          edit that most sessions are.

          A picker rather than a switch: what each mode does used to show only
          on hover, and only after you had already committed to a state. Same
          two descriptions as before, just read before you pick instead of
          after. */}
      {dispatchable > 0 && source === 'claude' && (
        <Select
          className="chat-setup-select"
          menuMinWidth={280}
          value={orchestrate ? 'lead' : 'agent'}
          options={LEAD_OPTIONS(dispatchable)}
          // Shown but inert on a running session, rather than dropped: this is
          // the one thing on the row that genuinely cannot change. The brief
          // is a spawn flag (`--append-system-prompt` for Claude,
          // `developerInstructions` at thread start for Codex) and neither CLI
          // has a way to replace it — so the honest move is to say which mode
          // the session is in and why it is stuck there.
          disabled={started}
          title={
            started
              ? `This session runs as ${orchestrate ? 'a lead' : 'a single agent'} — the brief goes in with the system prompt when the session starts, so it cannot change now. Start a new session to switch.`
              : undefined
          }
          onChange={(next) => onChange({ orchestrate: next === 'lead' })}
        />
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
function UsageLine({
  source,
  usage,
  busy
}: {
  source: 'claude' | 'codex'
  usage: ChatUsage
  busy: boolean
}): React.JSX.Element | null {
  const chips = usageChips(usage, useAccountUsage(source, busy))
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
  source: 'claude' | 'codex'
  /** The visible pane. Every composer stays mounted, so the ⌘P listener below
   *  would otherwise open the mic from whichever pane registered last. */
  active: boolean
  busy: boolean
  disabled: boolean
  /** Names only, no leading slash */
  slashCommands: string[]
  placeholder: string
  /** Only while the session is unstarted — the agent and checkout pickers */
  setup?: SessionSetup
  /** Context fullness and rate-limit window; empty until the first turn speaks */
  usage: ChatUsage
  /** Where `@`-mention file paths are read from. Absent in Home — no repo. */
  cwd?: string
  /**
   * Whether there is a Deepgram key to dictate against. The mic button shows
   * either way — hiding it would make the feature invisible to the one person
   * who has not set it up — and says what is missing when pressed.
   */
  sttReady?: boolean
  onSend: (text: string, attachments: Attachment[]) => void
  onInterrupt: () => void
  /** A staging failure has nowhere else to surface from in here */
  onError?: (message: string) => void
}

/** One `@`-mentionable file, read once per pane and filtered client-side */
type MentionFiles = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; paths: string[] }

export function ChatComposer({
  source,
  active,
  busy,
  disabled,
  slashCommands,
  placeholder,
  setup,
  usage,
  cwd,
  sttReady = false,
  onSend,
  onInterrupt,
  onError
}: ChatComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  /**
   * What was already typed when the mic opened. Dictated words are appended to
   * it rather than replacing the box, so a half-written message survives
   * pressing the button — and holding it here (not in the box) is what lets
   * the live partial be redrawn on every packet without eating the typing.
   */
  const dictationBase = useRef('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionFiles, setMentionFiles] = useState<MentionFiles>({ status: 'idle' })
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const dictation = useDictation((text) => {
    const next = joinDictated(dictationBase.current, text)
    setValue(next)
    setCaret(next.length)
    // The value prop lands on the next render; move the caret after that paint
    requestAnimationFrame(() => {
      areaRef.current?.focus()
      areaRef.current?.setSelectionRange(next.length, next.length)
    })
  }, onError)

  const dictating = dictation.phase !== 'idle'
  // While the mic is open the box shows the words as they land; `value` is
  // still only what was typed, so nothing is lost if the stream dies.
  const shownValue = dictating ? joinDictated(dictationBase.current, dictation.live) : value

  const toggleMic = (): void => {
    if (dictating) {
      dictation.stop()
      return
    }
    if (!sttReady) {
      onError?.('Add a Deepgram API key in Settings → Voice to turn on dictation.')
      return
    }
    dictationBase.current = value
    dictation.start()
  }

  // A ref so the listener below can be registered once per pane rather than
  // re-attached on every keystroke — `toggleMic` closes over the draft text.
  const toggleMicRef = useRef(toggleMic)
  toggleMicRef.current = toggleMic

  /**
   * ⌘P starts and stops dictation without reaching for the button.
   *
   * Meta only, deliberately — every other shortcut here matches
   * `metaKey || ctrlKey`, but **Ctrl+P is readline's "previous command"** and
   * these panes sit beside real terminals, so binding it would take a key back
   * from every shell in the app. Same reasoning that put the explorer on ⌘⇧B
   * rather than ⌘B.
   */
  useEffect(() => {
    if (!active || disabled) return
    const onKey = (e: KeyboardEvent): void => {
      // Holding the keys down auto-repeats, and every repeat is another
      // keydown — untreated, that opens and closes the mic many times a second
      // for as long as the key is held. Only the first press is the press.
      if (e.repeat) return
      if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'p') return
      e.preventDefault()
      toggleMicRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, disabled])

  // Grow with the content, up to a cap — a fixed single line makes pasting a
  // stack trace feel like a mistake
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 240)}px`
  }, [shownValue])

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
   * `@`-mention: reference a file without typing its path from memory. Reads
   * the whole project's file list once per pane, on the first `@` — a git
   * call is cheap, but there is no reason to pay it in a pane nobody uses it
   * in. Never active while the slash palette is (the two cannot really
   * collide — slash only matches when the entire value is `/word` with no
   * spaces — but the guard says so rather than relying on that).
   */
  const mention = !paletteOpen ? mentionAt(value, caret) : null

  useEffect(() => {
    if (!mention || !cwd || mentionFiles.status !== 'idle') return
    setMentionFiles({ status: 'loading' })
    void window.api.gitListFiles(cwd).then((res) => {
      setMentionFiles({ status: 'ready', paths: res.ok ? res.paths : [] })
    })
  }, [mention, cwd, mentionFiles.status])

  const mentionMatches = useMemo(() => {
    if (!mention || mentionFiles.status !== 'ready') return []
    return filterOptions(
      mentionFiles.paths.map((p) => ({ value: p, label: p })),
      mention.query
    ).slice(0, 8)
  }, [mention, mentionFiles])

  useEffect(() => setMentionIndex(0), [mention?.query])

  const mentionOpen = mention !== null && mentionMatches.length > 0

  const acceptMention = (path: string): void => {
    if (!mention) return
    const before = value.slice(0, mention.start)
    const after = value.slice(caret)
    const next = `${before}@${path} ${after}`
    setValue(next)
    const nextCaret = before.length + 1 + path.length + 1
    setCaret(nextCaret)
    // The value prop updates on the next render; the DOM selection has to be
    // set after that paint, or it snaps back to wherever it was before.
    requestAnimationFrame(() => areaRef.current?.setSelectionRange(nextCaret, nextCaret))
    areaRef.current?.focus()
  }

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
    if (!sendable || disabled || dictating) return
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

      {mentionOpen && (
        <div className="chat-palette">
          {mentionMatches.map((m, i) => (
            <button
              key={m.value}
              className={`chat-palette-item chat-mention-item${i === mentionIndex ? ' chat-palette-item--active' : ''}`}
              onMouseEnter={() => setMentionIndex(i)}
              onClick={() => acceptMention(m.value)}
            >
              <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
              <span className="chat-mention-path">{m.value}</span>
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
            value={shownValue}
            placeholder={dictating ? 'Listening…' : placeholder}
            disabled={disabled}
            // The box is a transcript while the mic is open: an edit made
            // against text the next packet is about to redraw would be lost.
            readOnly={dictating}
            onChange={(e) => {
              setValue(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (dictating) {
                // Escape is the pane's interrupt everywhere else; while the mic
                // is open it belongs to the mic, so it is stopped from reaching
                // the window listener that would stop the agent instead.
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  dictation.stop()
                  return
                }
                // Enter ends the sentence being spoken, not the message
                if (e.key === 'Enter') {
                  e.preventDefault()
                  dictation.stop()
                  return
                }
              }
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
              if (mentionOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIndex((i) => (i + 1) % mentionMatches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
                  return
                }
                // Both accept — a mention sits mid-sentence, so Enter here
                // picks a file rather than sending a message that isn't done
                if (e.key === 'Tab' || e.key === 'Enter') {
                  e.preventDefault()
                  acceptMention(mentionMatches[mentionIndex].value)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <IconButton
            label={dictating ? 'Stop dictating (Esc)' : 'Dictate a message (\u2318P)'}
            className={`chat-mic${dictating ? ' chat-mic--live' : ''}`}
            disabled={disabled}
            onClick={toggleMic}
          >
            {/* The ring follows the mic level, so a dead microphone looks
                different from a quiet room — it is the only feedback there is
                before the first word comes back. */}
            {dictation.phase === 'recording' && (
              <span
                className="chat-mic-level"
                style={{ transform: `scale(${1 + Math.min(1, dictation.level * 2) * 0.6})` }}
                aria-hidden="true"
              />
            )}
            <Mic size={15} strokeWidth={1.9} />
          </IconButton>
          {busy ? (
            <IconButton label="Stop (Esc)" className="chat-stop" onClick={onInterrupt}>
              <Square size={14} strokeWidth={2} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton
              label="Send (\u21b5)"
              className="chat-send"
              // Nothing is sent mid-sentence: the words still arriving are not
              // in `value` yet, so a send here would post half of them.
              disabled={disabled || !sendable || dictating}
              onClick={submit}
            >
              <ArrowUp size={16} strokeWidth={2} />
            </IconButton>
          )}
        </div>

        {setup && <SessionSetupRow setup={setup} busy={busy} />}
      </div>

      <UsageLine source={source} usage={usage} busy={busy} />
    </div>
  )
}
