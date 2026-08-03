import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
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
import { WorkingText } from '../ui'
import { ChatComposer, type SessionSetup } from './ChatComposer'
import { FindBar } from './FindBar'
import { ChatItemView } from './ChatItems'

/**
 * A chat pane: the same agent CLI a terminal pane runs, rendered as a
 * conversation (SPEC §chat). Mounted alongside `TerminalPane` and keyed by the
 * same pane id, so the tab strip cannot tell them apart.
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
   * runtime the pane needs. The text becomes the replacement's `initialPrompt`.
   */
  beforeFirstSend?: (text: string) => boolean
  /**
   * Present only while the session is unstarted. The agent and the checkout
   * are asked here rather than before the pane opens, because neither is
   * answerable until you know the task — and this is where the task is typed.
   */
  setup?: SessionSetup
  /** Blocks the composer and explains why — e.g. while a worktree is being cut */
  notice?: string
  /** Fires once, when the CLI reports the conversation id it opened */
  onSessionBound: (sessionId: string) => void
}

type Action =
  | { kind: 'event'; event: AgentChatEvent }
  | { kind: 'sent'; text: string }
  | { kind: 'seed'; items: ChatItem[] }

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.kind) {
    case 'event':
      return reduceChat(state, action.event)
    case 'sent':
      return appendUserMessage(state, action.text)
    case 'seed':
      // Prepended, not replaced: the read is async, so a fast first turn may
      // already have produced live items that must stay after the history
      return { ...state, items: [...action.items, ...state.items] }
  }
}

/**
 * How many items a resumed pane renders up front, and how many more each
 * "load earlier" adds. A long conversation is thousands of variable-height
 * markdown blocks; rendering them all cost ~29,000px of DOM on a real session.
 */
const PAGE = 50

export function ChatPane({
  chatId,
  active,
  source,
  initialPrompt,
  resumeFrom,
  beforeFirstSend,
  setup,
  notice,
  onSessionBound
}: ChatPaneProps): React.JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, undefined, emptyChatState)
  const [pinned, setPinned] = useState(true)
  /**
   * How many items at the *front* are withheld. Counting from the front rather
   * than keeping a "visible count" is what makes this safe for a live
   * conversation: new items append at the end and are always shown, and
   * nothing scrolls out of view from above as the agent talks.
   */
  const [hidden, setHidden] = useState(0)
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

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
    if (el.scrollTop < 240) setHidden((h) => Math.max(0, h - PAGE))
  }

  /**
   * Prepending a page pushes everything down, so the message the user was
   * reading would jump away. Restore the distance from the *bottom*, which is
   * what stays fixed when content is added above.
   *
   * Declared before the recorder below so it consumes the gap measured on the
   * previous render, not the one this render just invalidated.
   */
  const bottomGapRef = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || pinned) return
    el.scrollTop = el.scrollHeight - el.clientHeight - bottomGapRef.current
  }, [hidden, pinned])

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
    if (!el) return
    if (pinned) el.scrollTop = el.scrollHeight
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

  const send = useCallback(
    (text: string) => {
      setStarted(true)
      if (!consultedFirstSend.current) {
        consultedFirstSend.current = true
        // Taken by the caller: this pane is being replaced by one in a fresh
        // worktree, so echoing the message here would render it twice
        if (beforeFirstSendRef.current?.(text)) return
      }
      dispatch({ kind: 'sent', text })
      window.api.chatSend(chatId, text)
    },
    [chatId]
  )

  const decide = useCallback(
    (requestId: string, decision: ApprovalDecision) =>
      window.api.chatRespond(chatId, requestId, decision),
    [chatId]
  )

  const interrupt = useCallback(() => window.api.chatInterrupt(chatId), [chatId])

  const [loadingHistory, setLoadingHistory] = useState(Boolean(resumeFrom))
  useEffect(() => {
    if (!resumeFrom) return
    let cancelled = false
    window.api
      .getSession({ source: resumeFrom.source, filePath: resumeFrom.filePath })
      .then((result: { messages: NormalizedMessage[] }) => {
        if (cancelled) return
        const items = seedItems(result.messages)
        dispatch({ kind: 'seed', items })
        // Open on the most recent page; the rest loads as the user scrolls up
        setHidden(Math.max(0, items.length - PAGE))
        setLoadingHistory(false)
      })
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
    send(initialPrompt)
  }, [initialPrompt, send])

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
  const awaiting = pendingApprovals(state)
  const exited = state.exitCode !== null

  return (
    <div className="chat-pane" style={{ display: active ? 'flex' : 'none' }}>
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
        onOpen={() => setHidden(0)}
      />

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-thread">
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
          {shown.map((item) => (
            <ChatItemView
              key={item.id}
              item={item}
              home={window.api.homeDir}
              onDecide={decide}
            />
          ))}
          {notice && (
            <div className="chat-working">
              <WorkingText>{notice}</WorkingText>
            </div>
          )}
          {state.busy && awaiting.length === 0 && (
            <div className="chat-working">
              <WorkingText>Working…</WorkingText>
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
        busy={state.busy}
        // A parked permission request blocks the agent, so a typed message
        // would queue behind it with no sign of why nothing happened
        disabled={exited || awaiting.length > 0 || Boolean(notice)}
        slashCommands={state.info?.slashCommands ?? []}
        setup={started ? undefined : setup}
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
      />
    </div>
  )
}
