import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  Ban,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  FileText,
  Loader
} from 'lucide-react'
import type { ApprovalDecision, ChatItem, ToolCall } from '../../../../shared/agent-chat'
import { Button, WorkingText } from '../ui'
import { useSmoothText } from './useSmoothText'

/**
 * The rendered forms of a chat item. Kept apart from `ChatPane` so the pane
 * owns transport and this file owns appearance.
 *
 * Reuses the transcript layer's `.message-markdown` so a live reply and the
 * same reply re-read later from the session file look identical.
 */

/** One-line gist of a tool call, from the argument that carries the meaning. */
export function toolSummary(call: ToolCall): string {
  if (call.description) return call.description
  const input = (call.input ?? {}) as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/** Home-relative paths read better than absolute ones in a narrow chip. */
function shorten(text: string, home: string): string {
  const relative = home && text.startsWith(home) ? `~${text.slice(home.length)}` : text
  return relative.length > 120 ? `${relative.slice(0, 117)}…` : relative
}

const STATUS_ICON: Record<ToolCall['status'], React.ReactNode> = {
  running: <Loader size={13} strokeWidth={1.75} className="chat-tool-spin" />,
  awaiting: <AlertTriangle size={13} strokeWidth={1.75} />,
  ok: <Check size={13} strokeWidth={1.75} />,
  error: <AlertTriangle size={13} strokeWidth={1.75} />,
  denied: <Ban size={13} strokeWidth={1.75} />,
  cancelled: <CircleSlash size={13} strokeWidth={1.75} />
}

const STATUS_TITLE: Partial<Record<ToolCall['status'], string>> = {
  cancelled: 'Stopped before this finished',
  denied: 'You denied this',
  error: 'This tool reported an error'
}

function ToolChip({ call, home }: { call: ToolCall; home: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = toolSummary(call)
  const expandable = Boolean(call.result)

  return (
    <div className={`chat-tool chat-tool--${call.status}`}>
      <div
        className={`chat-tool-head${expandable ? ' chat-tool-head--expandable' : ''}`}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        title={expandable ? 'Show tool output' : undefined}
      >
        {expandable && (
          <span className="chat-tool-chevron">
            {open ? (
              <ChevronDown size={13} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={13} strokeWidth={1.75} />
            )}
          </span>
        )}
        <span className="chat-tool-status" title={STATUS_TITLE[call.status]}>
          {STATUS_ICON[call.status]}
        </span>
        <span className="chat-tool-name">{call.displayName ?? call.name}</span>
        {summary && <code className="chat-tool-summary">{shorten(summary, home)}</code>}
      </div>
      {open && call.result && <pre className="chat-tool-output">{call.result}</pre>}
    </div>
  )
}

/**
 * The inline permission prompt. Every button here comes from the CLI: the
 * "always" option only appears when the CLI proposed one, and it is echoed back
 * untouched — so Chewo never invents a permission it does not understand.
 */
function ApprovalCard({
  call,
  home,
  onDecide
}: {
  call: ToolCall
  home: string
  onDecide: (requestId: string, decision: ApprovalDecision) => void
}): React.JSX.Element {
  const summary = toolSummary(call)
  const suggestion = call.suggestions?.[0]
  const requestId = call.requestId ?? ''

  const suggestionLabel =
    suggestion?.type === 'setMode' && suggestion.mode === 'acceptEdits'
      ? 'Allow edits for this session'
      : suggestion?.type === 'setMode' && suggestion.mode
        ? `Switch to ${suggestion.mode}`
        : 'Always allow'

  return (
    <div className="chat-approval">
      <div className="chat-approval-head">
        <AlertTriangle size={14} strokeWidth={1.75} />
        <span className="chat-approval-title">
          Allow <strong>{call.displayName ?? call.name}</strong>?
        </span>
      </div>
      {summary && <code className="chat-approval-target">{shorten(summary, home)}</code>}
      <ApprovalInput call={call} />
      <div className="chat-approval-actions">
        <Button
          intent="primary"
          size="compact"
          onClick={() => onDecide(requestId, { behavior: 'allow', updatedInput: call.input })}
        >
          Allow once
        </Button>
        {suggestion && (
          <Button
            size="compact"
            onClick={() =>
              onDecide(requestId, { behavior: 'allow', updatedInput: call.input, suggestion })
            }
          >
            {suggestionLabel}
          </Button>
        )}
        <Button
          intent="danger"
          size="compact"
          onClick={() => onDecide(requestId, { behavior: 'deny' })}
        >
          Deny
        </Button>
      </div>
    </div>
  )
}

/** The full arguments, collapsed — approving a Write without seeing the body is
 *  how a GUI becomes less safe than the terminal it replaced. */
function ApprovalInput({ call }: { call: ToolCall }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const json = JSON.stringify(call.input ?? {}, null, 2)
  if (json === '{}') return null
  return (
    <div className="chat-approval-input">
      <button className="chat-approval-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        {open ? 'Hide' : 'Show'} full input
      </button>
      {open && <pre className="chat-tool-output">{json}</pre>}
    </div>
  )
}

/**
 * Whether a thinking block has readable content is per-model, not per-turn:
 * haiku streams its reasoning as `thinking_delta`s, while opus sends only an
 * encrypted signature — the block exists, the text never does (verified
 * 2026-08-02). Offering a disclosure triangle that opens onto nothing is worse
 * than not offering one, so an empty block renders as a plain marker.
 */
function ThinkingBlock({ text, done }: { text: string; done: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const smoothed = useSmoothText(text, done)
  const hasText = text.length > 0

  if (!hasText) {
    return (
      <div className="chat-thinking">
        <span
          className="chat-thinking-head chat-thinking-head--static"
          title={done ? 'This model keeps its reasoning private' : undefined}
        >
          <Brain size={13} strokeWidth={1.75} />
          {done ? <span>Thought it through</span> : <WorkingText>Thinking…</WorkingText>}
        </span>
      </div>
    )
  }

  return (
    <div className="chat-thinking">
      <button className="chat-thinking-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} strokeWidth={1.75} /> : <ChevronRight size={13} strokeWidth={1.75} />}
        <Brain size={13} strokeWidth={1.75} />
        {done ? <span>Thought it through</span> : <WorkingText>Thinking…</WorkingText>}
      </button>
      {open && <div className="chat-thinking-body">{smoothed}</div>}
    </div>
  )
}

/** Block cursor, appended to the markdown *source* rather than rendered beside
 *  it — as a sibling element it lands after the trailing `<p>` and so sits on
 *  its own line instead of at the end of the sentence. */
const CARET = '▊'

function AssistantText({ text, done }: { text: string; done: boolean }): React.JSX.Element {
  const smoothed = useSmoothText(text, done)
  const streaming = !done || smoothed.length < text.length
  return (
    <div className={`chat-assistant message-markdown${streaming ? ' chat-assistant--streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming ? smoothed + CARET : smoothed}</ReactMarkdown>
    </div>
  )
}

export function ChatItemView({
  item,
  home,
  onDecide
}: {
  item: ChatItem
  home: string
  onDecide: (requestId: string, decision: ApprovalDecision) => void
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      // Literal, never markdown — pasted code and logs must survive verbatim
      return (
        <div className="chat-user">
          {item.text}
          {/* What was attached, in the same shape the composer showed. The
              blocks themselves went to the agent in full; repeating them here
              would make the transcript unreadable. */}
          {item.attachments?.length ? (
            <div className="chat-user-attachments">
              {item.attachments.map((a) => (
                <span key={a.id} className={`chat-user-attachment chat-user-attachment--${a.kind}`}>
                  {a.kind === 'image' && a.preview ? (
                    <img className="chat-user-attachment-thumb" src={a.preview} alt="" />
                  ) : (
                    <FileText size={12} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {a.label}
                  {a.lines ? ` · ${a.lines} lines` : ''}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )

    case 'text':
      return <AssistantText text={item.text} done={item.done} />


    case 'thinking':
      return <ThinkingBlock text={item.text} done={item.done} />

    case 'tool':
      return item.call.status === 'awaiting' ? (
        <ApprovalCard call={item.call} home={home} onDecide={onDecide} />
      ) : (
        <ToolChip call={item.call} home={home} />
      )

    case 'notice':
      return <div className={`chat-notice chat-notice--${item.tone}`}>{item.text}</div>

    case 'turn':
      // A cost line after every turn is noise; only an abnormal ending needs
      // saying — and stopping on purpose is not a failure.
      if (item.stats.cancelled)
        return <div className="chat-notice chat-notice--info">Stopped.</div>
      return item.stats.isError ? (
        <div className="chat-notice chat-notice--error">The turn ended with an error.</div>
      ) : null
  }
}
