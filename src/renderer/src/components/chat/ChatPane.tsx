import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import { Sparkles } from 'lucide-react'
import {
  appendUserMessage,
  emptyChatState,
  pendingApprovals,
  reduceChat,
  seedItems,
  type AgentChatEvent,
  type ApprovalDecision,
  type ChatItem,
  type ChatState
} from '../../../../shared/agent-chat'
import type { NormalizedMessage } from '../../../../shared/adapter/types'
import type { AgentTask } from '../../../../shared/tool-tasks'
import { groupChatItems } from '../../../../shared/chat-groups'
import {
  chipOf,
  chipsForPaths,
  composeMessage,
  splitComposed,
  type Attachment,
  type AttachmentChip
} from '../../../../shared/attachments'
import { WorkingText } from '../ui'
import { ChatComposer, type SessionSetup } from './ChatComposer'
import { EFFORT_LEVELS, matchModelId, type EffortLevel } from '../../../../shared/agents'
import { FindBar } from './FindBar'
import { ChatRowView } from './ChatItems'
import { TaskPanel } from './TaskPanel'
import { useElapsed } from './useElapsed'

/**
 * A chat pane: the same agent CLI a terminal pane runs, rendered as a
 * conversation (SPEC §chat). Mounted alongside `TerminalPane` and keyed by the
 * same pane id, so the surrounding workspace does not need runtime-specific state.
 *
 * State is a `useReducer` over the shared fold in `agent-chat.ts` — the same
 * function the tests replay recorded sessions through, so what ships and what
 * is tested are one implementation.
 */

interface ChatPaneProps {
  chatId: number
  active: boolean
  source: 'claude' | 'codex'
  /**
   * A card run or worktree task that should start without the user typing.
   * Sent from here rather than from main so it goes through the ordinary send
   * path — it renders as their message and sets the busy state — and so it
   * cannot be emitted before this pane exists to receive it.
   */
  initialPrompt?: string
  /**
   * Staged image paths belonging to `initialPrompt`. A pane replaced on its
   * first message inherits both: the pasted text is already folded into the
   * prompt, but pixels cannot be, so the files come across separately.
   */
  initialImages?: string[]
  /**
   * The conversation this pane was opened to resume. Its transcript is read
   * from disk and shown as history, because the CLI replays nothing on
   * `--resume`. Only ever the session the pane *started* with — seeding from a
   * session the pane opened itself would duplicate the live messages.
   */
  resumeFrom?: { sessionId: string; source: 'claude' | 'codex'; filePath: string }
  /**
   * Consulted once, on the very first message this pane sends. Returning true
   * means the caller took the message — this pane sends nothing and is about
   * to be replaced. It is how the setup row's choices are deferred until there
   * is a task: a branch is named after one, and the agent decides which
   * runtime the pane needs. The text becomes the replacement's `initialPrompt`
   * and the staged images its `initialImages`.
   */
  beforeFirstSend?: (text: string, images: string[]) => boolean
  /**
   * The composer's setup row. On an unstarted pane it asks everything — the
   * agent and the checkout are answered here rather than before the pane
   * opens, because neither is answerable until you know the task, and this is
   * where the task is typed. On a running one it keeps only what a live
   * session can still change: the model and the reasoning effort.
   */
  setup?: SessionSetup
  /** Whether dictation has a key to run against; the mic says so if not */
  sttReady?: boolean
  /** Blocks the composer and explains why — e.g. while a worktree is being cut */
  notice?: string
  /** Fires once, when the CLI reports the conversation id it opened */
  onSessionBound: (sessionId: string) => void
  /** Surfaced as a toast — a pasted image that could not be staged */
  onError?: (message: string) => void
  /** Where the composer's `@`-mention picker reads files from */
  cwd?: string
}

type Action =
  | { kind: 'event'; event: AgentChatEvent }
  | { kind: 'sent'; text: string; attachments: AttachmentChip[] }
  | { kind: 'seed'; items: ChatItem[]; tasks?: AgentTask[] }

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.kind) {
    case 'event':
      return reduceChat(state, action.event)
    case 'sent':
      return appendUserMessage(state, action.text, action.attachments)
    case 'seed':
      // Prepended, not replaced: the read is async, so a fast first turn may
      // already have produced live items that must stay after the history.
      // The plan is the opposite — it is one list, and a live turn that has
      // already moved it knows better than the file does.
      return {
        ...state,
        items: [...action.items, ...state.items],
        tasks: state.tasks.length ? state.tasks : (action.tasks ?? [])
      }
  }
}

/**
 * How many items a resumed pane renders up front, and how many more each
 * "load earlier" adds. A long conversation is thousands of variable-height
 * markdown blocks; rendering them all cost ~29,000px of DOM on a real session.
 */
const PAGE = 50

/** A transcript's recorded effort, kept only if it is still a level we offer. */
const asEffort = (value: string | undefined): EffortLevel | '' =>
  value && (EFFORT_LEVELS as string[]).includes(value) ? (value as EffortLevel) : ''

export function ChatPane({
  chatId,
  active,
  source,
  initialPrompt,
  initialImages,
  resumeFrom,
  beforeFirstSend,
  setup,
  sttReady,
  notice,
  onSessionBound,
  onError,
  cwd
}: ChatPaneProps): React.JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChatState)
  /**
   * How many items at the *front* are withheld. Counting from the front rather
   * than keeping a "visible count" is what makes this safe for a live
   * conversation: new items append at the end and are always shown, and
   * nothing scrolls out of view from above as the agent talks.
   */
  const [hidden, setHidden] = useState(0)
  /** Bumped when find opens, so every folded tool group renders its chips —
   *  find walks the DOM and cannot see what is not in it. */
  const [unfold, setUnfold] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Ref so the subscription is keyed on chatId alone — a new callback identity
  // from App re-rendering must not tear down and re-add the listener
  const onSessionBoundRef = useRef(onSessionBound)
  onSessionBoundRef.current = onSessionBound
  const boundRef = useRef('')

  useEffect(() => {
    return window.api.onChatEvent(({ id, event }) => {
      if (id !== chatId) return
      // The CLI re-announces itself each turn; only report a genuinely new id
      if (event.type === 'session' && event.info.sessionId && event.info.sessionId !== boundRef.current) {
        boundRef.current = event.info.sessionId
        onSessionBoundRef.current(event.info.sessionId)
      }
      dispatch({ kind: 'event', event })
    })
  }, [chatId])


  const loadEarlier = useCallback(() => setHidden((h) => Math.max(0, h - PAGE)), [])

  /**
   * Whether the view follows the stream. A ref rather than state for two
   * reasons: nothing renders off it, and the layout effects below must see the
   * user's wheel *immediately* — a `setState` would land a render later, and a
   * token arriving in that gap would pin the view back to the bottom under a
   * scroll that had already begun.
   */
  const pinnedRef = useRef(true)
  const bottomGapRef = useRef(0)

  /**
   * Every pane stays mounted and is hidden with `display: none`, which zeroes
   * `scrollHeight`, `clientHeight` and `scrollTop`. Any pane re-rendering — and
   * they all re-render whenever App does — would then "pin" a conversation
   * nobody is looking at to a bottom that measures 0, i.e. scroll it to the
   * top, and record a bogus gap. So every scroll write is gated on this pane
   * actually being on screen.
   */
  const measurable = (el: HTMLDivElement): boolean => active && el.clientHeight > 0

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el || !measurable(el)) return
    // Re-pins only by reaching the bottom again, so scrolling away stays away
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (el.scrollTop < 240) setHidden((h) => Math.max(0, h - PAGE))
  }

  // Unpin on the gesture, not on the scroll event it eventually produces:
  // during a stream the effect below runs on every token, and one of those
  // renders can fall between the wheel and the `scroll` that follows it.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (e.deltaY < 0) pinnedRef.current = false
  }
  const onTouchMove = (): void => {
    pinnedRef.current = false
  }

  /**
   * Restores the distance from the *bottom* — the thing that stays fixed when
   * content is added above. Two cases, same arithmetic: a page prepended by
   * "load earlier" pushes everything down, and a pane returning from
   * `display: none` comes back with its scroll offset discarded.
   *
   * Declared before the recorder below so it consumes the gap measured on the
   * previous render, not the one this render just invalidated. `pinnedRef` is
   * read rather than depended on, because firing this on the pinned → unpinned
   * transition is precisely what used to yank the user back to the bottom the
   * moment they scrolled up.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !measurable(el) || pinnedRef.current) return
    el.scrollTop = el.scrollHeight - el.clientHeight - bottomGapRef.current
  }, [hidden, active])

  /**
   * Runs every render, deliberately. Pinning once when the items change is not
   * enough: markdown finishes laying out *after* that effect, growing the
   * scroll height underneath it, which left a resumed pane a screen short of
   * the newest message. Re-asserting each render also follows the stream while
   * the agent is talking — and only while the user is already at the bottom,
   * so it never yanks the view back mid-read.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !measurable(el)) return
    if (pinnedRef.current) el.scrollTop = el.scrollHeight
    else bottomGapRef.current = el.scrollHeight - el.scrollTop - el.clientHeight
  })

  // Ref so `send` keeps a stable identity — the initial-prompt effect below
  // depends on it, and a new callback from App re-rendering must not re-fire it
  const beforeFirstSendRef = useRef(beforeFirstSend)
  beforeFirstSendRef.current = beforeFirstSend
  const consultedFirstSend = useRef(false)
  /**
   * The setup row goes the moment the first message is sent, not when the CLI
   * gets round to announcing a session id — that arrives a turn later, and a
   * row still offering to change the checkout after the agent has started is
   * offering something it can no longer do.
   */
  const [started, setStarted] = useState(false)

  /**
   * The `/` catalog for a pane that has not spawned anything yet. A pending
   * pane never receives the CLI's `initialize` reply — there is no process to
   * send it — so its menu was empty until the first message had already gone.
   * Main answers this from a throwaway handshake in the same checkout and
   * caches it per cwd; `[]` on any failure, which is where the menu was
   * anyway. Only ever a fallback: the live session's own catalog replaces it
   * below the moment `system/init` lands.
   */
  const [pendingCommands, setPendingCommands] = useState<string[]>([])
  useEffect(() => {
    if (started || !setup) return
    let live = true
    setPendingCommands([])
    window.api.chatCommands(source, cwd).then((commands) => {
      if (live) setPendingCommands(commands)
    })
    return () => {
      live = false
    }
  }, [started, setup, source, cwd])

  /**
   * The one place a turn leaves this pane. `display` is what the bubble shows
   * — the sentence the user typed — while `message` is what the agent reads,
   * with any pasted text folded back in verbatim. They diverge on purpose: a
   * 900-line log belongs in the model's context, not in the transcript the
   * user is scrolling.
   */
  const deliver = useCallback(
    (display: string, message: string, images: string[], chips: AttachmentChip[]) => {
      setStarted(true)
      // Sending is an explicit act of moving the conversation on, so it follows
      // the reply even if the user had scrolled back to read something
      pinnedRef.current = true
      if (!consultedFirstSend.current) {
        consultedFirstSend.current = true
        // Taken by the caller: this pane is being replaced by one in a fresh
        // worktree, so echoing the message here would render it twice
        if (beforeFirstSendRef.current?.(message, images)) return
      }
      dispatch({ kind: 'sent', text: display, attachments: chips })
      window.api.chatSend(chatId, message, images)
    },
    [chatId]
  )

  const send = useCallback(
    (text: string, attachments: Attachment[]) => {
      const images = attachments
        .filter((a) => a.kind === 'image' && a.path)
        .map((a) => a.path as string)
      deliver(text, composeMessage(text, attachments), images, attachments.map(chipOf))
    },
    [deliver]
  )

  const decide = useCallback(
    (requestId: string, decision: ApprovalDecision) =>
      window.api.chatRespond(chatId, requestId, decision),
    [chatId]
  )

  const interrupt = useCallback(() => window.api.chatInterrupt(chatId), [chatId])

  const [loadingHistory, setLoadingHistory] = useState(Boolean(resumeFrom))
  /**
   * What the transcript says this conversation was last running on. Only ever
   * a fallback for the composer's row: the moment a live turn reports a model,
   * or the user picks one, that wins.
   */
  const [resumedFrom, setResumedFrom] = useState<{ model?: string; effort?: string }>({})
  useEffect(() => {
    if (!resumeFrom) return
    let cancelled = false
    window.api
      .getSession({ source: resumeFrom.source, filePath: resumeFrom.filePath })
      .then(
        (result: {
          messages: NormalizedMessage[]
          contextTokens?: number
          model?: string
          effort?: string
          tasks?: AgentTask[]
        }) => {
        if (cancelled) return
        const items = seedItems(result.messages)
        // Resuming replays nothing, so a pane that had a plan going would come
        // back without one — it is folded out of the transcript instead.
        dispatch({ kind: 'seed', items, tasks: result.tasks })
        // The transcript knows how full the window was when the conversation
        // stopped; the CLI will not say so again until the next turn ends. The
        // window's *size* is not in the file, so this reads as a token count
        // until the first reply — a number one turn stale beats a blank.
        if (result.contextTokens)
          dispatch({
            kind: 'event',
            event: { type: 'usage', usage: { contextTokens: result.contextTokens } }
          })
        // Neither CLI announces its model or effort on resume, and the first
        // turn is where it would — which is one turn too late to be able to
        // change it before speaking.
        setResumedFrom({ model: result.model, effort: result.effort })
        // Open on the most recent page; the rest loads as the user scrolls up
        setHidden(Math.max(0, items.length - PAGE))
        setLoadingHistory(false)
      }
      )
      .catch(() => {
        // A missing or unreadable transcript is not fatal — the conversation
        // still resumes, it just opens without its history
        if (!cancelled) setLoadingHistory(false)
      })
    return () => {
      cancelled = true
    }
  }, [resumeFrom?.source, resumeFrom?.filePath])

  // Fire once per pane. The guard is a ref rather than a dep because `send`
  // changes identity on nothing in particular, and a second submit would run
  // the card twice.
  const sentInitial = useRef(false)
  useEffect(() => {
    if (!initialPrompt || sentInitial.current) return
    sentInitial.current = true
    // Already composed by the pane this one replaced, so it goes to the agent
    // as-is; only the bubble is unpacked, back into the chips it came from
    const images = initialImages ?? []
    const { display, chips } = splitComposed(initialPrompt)
    deliver(display, initialPrompt, images, [...chipsForPaths(images), ...chips])
  }, [initialPrompt, initialImages, deliver])

  // Esc stops the turn, matching the CLI it is standing in for
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state.busy) {
        e.preventDefault()
        interrupt()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, state.busy, interrupt])

  const shown = hidden > 0 ? state.items.slice(hidden) : state.items
  // Folded after the paging window is applied, so a group never reaches across
  // the "load earlier" boundary into items that are not rendered.
  const rows = groupChatItems(shown)
  const awaiting = pendingApprovals(state)
  const exited = state.exitCode !== null
  const elapsed = useElapsed(state.busy, active)
  const showEmptyState = !started && Boolean(setup) && !loadingHistory && state.items.length === 0

  /**
   * The row the composer draws, and the one place the two states of it meet.
   *
   * `started` is true either because App said so — the pane has a process
   * behind it — or because this pane has just sent its first message and is
   * about to be replaced. Both mean the same thing to the row: the agent and
   * the checkout are settled, the model and the effort are not.
   *
   * The model needs resolving here rather than in App because App only knows
   * what the *user* picked. A session resumed from the sidebar spawned with no
   * model flag at all, so the only thing that knows what it is running is the
   * CLI's own `system/init` — which reports a resolved id (`claude-sonnet-5`)
   * where the picker holds tier aliases (`sonnet`).
   */
  const composerSetup = useMemo(() => {
    if (!setup) return undefined
    const live = setup.started === true || started
    if (!live) return setup
    return {
      ...setup,
      started: true,
      // Three sources, in order of how current they are: what the user picked,
      // what this session's own `system/init` reported, and what the
      // transcript last recorded.
      model:
        setup.model ||
        matchModelId(state.info?.model || resumedFrom.model || '', setup.models),
      effort: setup.effort || asEffort(resumedFrom.effort)
    }
  }, [setup, started, state.info?.model, resumedFrom])

  return (
    <div
      className={`chat-pane${showEmptyState ? ' chat-pane--empty' : ''}`}
      style={{ display: active ? 'flex' : 'none' }}
    >
      {/* No header. The cwd was a duplicate of the tab's own ⎇ label and the
          branch chip beside it, and the "Terminal" escape hatch cost a full
          bar's height to sit there unused — a conversation still moves to a
          pty through `openInTerminal`, it just needs a caller again if that is
          ever wanted back. What is left worth showing is the model, and it is
          unknown until the first turn anyway. */}

      {/* Find searches the DOM, so it needs the whole conversation rendered —
          opening it expands the window rather than quietly searching a page. */}
      <FindBar
        containerRef={scrollRef}
        active={active}
        revision={`${state.items.length}:${hidden}`}
        onOpen={() => {
          setHidden(0)
          setUnfold((n) => n + 1)
        }}
      />

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchMove={onTouchMove}
      >
        <div className="chat-thread">
          {/* Only a pane with nothing behind it yet — the moment there is
              real history or a live turn, the thread itself is the content
              and a headline above it would just be in the way. */}
          {showEmptyState && (
            <div className="chat-empty-state">
              <div className="chat-empty-mark">
                <Sparkles size={20} strokeWidth={1.6} aria-hidden="true" />
              </div>
              <h2>Ready when you are</h2>
              <p>
                {source === 'claude'
                  ? 'Describe the task below, or type / for a command.'
                  : 'Describe the task below.'}
              </p>
            </div>
          )}
          {loadingHistory && (
            <div className="chat-working">
              <WorkingText>Loading history…</WorkingText>
            </div>
          )}
          {hidden > 0 && (
            <button className="chat-load-earlier" onClick={loadEarlier}>
              Load {Math.min(PAGE, hidden)} earlier {hidden === 1 ? 'message' : 'messages'}
              <span className="chat-load-earlier-count">{hidden} above</span>
            </button>
          )}
          {rows.map((row) => (
            <ChatRowView
              key={row.id}
              row={row}
              home={window.api.homeDir}
              unfold={unfold}
              onDecide={decide}
            />
          ))}
          {/* At the end of the thread rather than where the plan was created:
              it is the current state of one list, not a thing that happened at
              a point in the conversation — and the bottom is where a streaming
              pane is already pinned, so it stays in view while it matters. */}
          <TaskPanel tasks={state.tasks} />
          {notice && (
            <div className="chat-working">
              <WorkingText>{notice}</WorkingText>
            </div>
          )}
          {state.busy && awaiting.length === 0 && (
            <div className="chat-working">
              <WorkingText>Working…</WorkingText>
              {elapsed && <span className="chat-elapsed">{elapsed}</span>}
            </div>
          )}
          {exited && (
            <div className="chat-notice chat-notice--info">
              Session ended{state.exitCode ? ` (exit ${state.exitCode})` : ''}.
            </div>
          )}
        </div>
      </div>

      <ChatComposer
        source={source}
        active={active}
        busy={state.busy}
        // A parked permission request blocks the agent, so a typed message
        // would queue behind it with no sign of why nothing happened
        disabled={exited || awaiting.length > 0 || Boolean(notice)}
        slashCommands={state.info?.slashCommands ?? pendingCommands}
        setup={composerSetup}
        usage={state.usage}
        cwd={cwd}
        sttReady={sttReady}
        placeholder={
          exited
            ? 'Session ended'
            : notice
              ? notice
              : awaiting.length > 0
                ? 'Waiting on the permission above…'
                : // An unstarted pane says which agent will read this, because
                  // that is still a choice at this point
                  !started && setup
                  ? `Ask ${setup.source === 'codex' ? 'Codex' : 'Claude'}…`
                  : 'Ask anything…'
        }
        onSend={send}
        onInterrupt={interrupt}
        onError={onError}
      />
    </div>
  )
}
