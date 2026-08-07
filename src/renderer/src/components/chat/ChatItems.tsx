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
  Loader,
  MessageCircleQuestion
} from 'lucide-react'
import type { ApprovalDecision, ChatItem, ToolCall } from '../../../../shared/agent-chat'
import {
  composeAnswers,
  parseAskQuestions,
  type AskQuestion
} from '../../../../shared/ask-user-question'
import { patchStats, patchToUnified, type ToolPatch } from '../../../../shared/diff'
import { imageDataUrl, type ToolImage } from '../../../../shared/tool-images'
import { isPlanTool } from '../../../../shared/tool-tasks'
import { DiffBody } from '../DiffBody'
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

/** Rows shown before the diff folds. Long enough for an ordinary edit to arrive
 *  whole, short enough that a rewritten file does not bury the conversation. */
const DIFF_PREVIEW_ROWS = 24

/**
 * The change itself, rendered by the same `DiffBody` the git panel uses — so a
 * change an agent just made and the same change read back from `git diff` look
 * alike, down to the gutter.
 */
function DiffView({ patch }: { patch: ToolPatch }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const { text, hidden } = patchToUnified(patch, showAll ? undefined : DIFF_PREVIEW_ROWS)
  // Rows the *parser* dropped are gone for good; only the rest can be unfolded,
  // so a diff cut by the cap never offers a button that would reveal nothing.
  const unfoldable = hidden - (patch.omitted ?? 0)

  return (
    <div className="chat-diff">
      <DiffBody text={text} truncated={false} />
      {/* Never fold silently — a diff that quietly stops reads as the whole
          change, which is worse than showing no diff at all. */}
      {unfoldable > 0 ? (
        <button className="chat-diff-more" onClick={() => setShowAll(true)}>
          Show {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      ) : hidden > 0 ? (
        <div className="chat-diff-more chat-diff-more--capped">
          {hidden} more {hidden === 1 ? 'line' : 'lines'} — too large to capture
        </div>
      ) : null}
    </div>
  )
}

/**
 * What a tool handed back as a picture — a Read of a PNG, an MCP screenshot.
 * Shown at a readable size and clickable to full resolution, since the reason
 * to look at one is usually a detail.
 */
function ToolImages({ images }: { images: ToolImage[] }): React.JSX.Element {
  const [full, setFull] = useState<number | null>(null)
  return (
    <div className="chat-tool-images">
      {images.map((image, i) => (
        <img
          key={i}
          className={`chat-tool-image${full === i ? ' chat-tool-image--full' : ''}`}
          src={imageDataUrl(image)}
          alt=""
          title={full === i ? 'Click to shrink' : 'Click for full size'}
          onClick={() => setFull(full === i ? null : i)}
        />
      ))}
    </div>
  )
}

function ToolChip({ call, home }: { call: ToolCall; home: string }): React.JSX.Element {
  // `null` means "not decided yet", so a diff can open by default while a
  // click still wins — the patch arrives after the chip mounts, so an
  // initial-state default would always be computed before there is one.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const summary = toolSummary(call)
  const patch = call.patch
  const images = call.images ?? []
  const expandable = Boolean(call.result || patch || images.length)
  // A picture is the whole point of the call that produced it, so it opens like
  // a diff rather than hiding behind a chevron.
  const open = toggled ?? Boolean(patch || images.length)
  const stats = patch ? patchStats(patch) : null

  return (
    <div className={`chat-tool chat-tool--${call.status}`}>
      <div
        className={`chat-tool-head${expandable ? ' chat-tool-head--expandable' : ''}`}
        onClick={expandable ? () => setToggled(!open) : undefined}
        title={expandable ? (patch ? patch.filePath : 'Show tool output') : undefined}
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
        {stats && (
          <span className="chat-diff-stat">
            {stats.added > 0 && <span className="chat-diff-stat-add">+{stats.added}</span>}
            {stats.removed > 0 && <span className="chat-diff-stat-del">−{stats.removed}</span>}
          </span>
        )}
      </div>
      {/* The diff supersedes the prose it describes: "the file has been updated
          successfully" says nothing the chip's own tick does not. */}
      {open && (
        <>
          {images.length > 0 && <ToolImages images={images} />}
          {patch ? (
            <DiffView patch={patch} />
          ) : call.result ? (
            <pre className="chat-tool-output">{call.result}</pre>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * The card for a tool whose approval prompt *is* its UI — today that means
 * `AskUserQuestion`. There is no Allow/Deny here on purpose: allowing was never
 * the question, and answering *is* the permission (see `ask-user-question.ts`
 * for the wire contract this depends on).
 *
 * One question per page. The tool takes up to four questions of up to four
 * options each, and every option can carry a description — stacked, that is a
 * card taller than the window, which reads as a wall rather than as a question.
 * Paging is purely presentational: `composeAnswers` still receives every pick
 * at once, so the wire contract is untouched.
 */
function QuestionCard({
  call,
  questions,
  onDecide
}: {
  call: ToolCall
  questions: AskQuestion[]
  onDecide: (requestId: string, decision: ApprovalDecision) => void
}): React.JSX.Element {
  /** Chosen option labels per question — free text lands here as its own entry */
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []))
  /** Which questions have the free-text field open, and what is in it */
  const [other, setOther] = useState<Record<number, string>>({})
  const [page, setPage] = useState(0)
  const requestId = call.requestId ?? ''
  const last = questions.length - 1

  const toggle = (index: number, label: string): void => {
    setPicks((prev) =>
      prev.map((chosen, i) => {
        if (i !== index) return chosen
        if (!questions[i].multiSelect) return chosen[0] === label ? [] : [label]
        return chosen.includes(label) ? chosen.filter((l) => l !== label) : [...chosen, label]
      })
    )
    // Picking the single answer a question accepts *is* moving on, so a
    // one-of-four question costs one click rather than two. Multi-select can't
    // do this (there is no way to know you are finished), and the last page
    // never auto-advances into a send: the tool result is always an explicit act.
    if (!questions[index].multiSelect && index < last && !picks[index].includes(label)) {
      setPage(index + 1)
    }
  }

  // The tool's own description tells the model not to offer an "Other" option
  // because the client provides one; without it a question with no fitting
  // answer can only be abandoned.
  const answersFor = (): string[][] =>
    picks.map((chosen, i) => {
      const typed = (other[i] ?? '').trim()
      return typed ? [...chosen, typed] : chosen
    })

  const filled = answersFor()
  const answered = filled.every((a) => a.length > 0)
  const q = questions[page]

  const send = (): void =>
    onDecide(requestId, {
      behavior: 'allow',
      // Merged into the request's own input: the tool reads its questions back
      // out of it, so replacing rather than extending loses them
      updatedInput: {
        ...(call.input as Record<string, unknown>),
        answers: composeAnswers(questions, answersFor())
      }
    })

  return (
    <div className="chat-question">
      <div className="chat-question-head">
        <MessageCircleQuestion size={14} strokeWidth={1.75} />
        <span>{questions.length > 1 ? 'A few questions for you' : 'A question for you'}</span>
        {questions.length > 1 && (
          <span className="chat-question-steps">
            {questions.map((step, i) => (
              // Jumping straight to a question is what makes the dots worth
              // drawing — going back to change an answer should not mean
              // walking back through every page between here and there.
              <button
                key={step.question}
                className={`chat-question-step${i === page ? ' chat-question-step--on' : ''}${
                  filled[i].length ? ' chat-question-step--done' : ''
                }`}
                onClick={() => setPage(i)}
                title={step.header || step.question}
                aria-label={`Question ${i + 1} of ${questions.length}`}
                aria-current={i === page}
              />
            ))}
          </span>
        )}
      </div>

      {/* Keyed on the question so React rebuilds the block rather than
          reconciling one question's options onto another's. */}
      <div key={q.question} className="chat-question-block">
        <div className="chat-question-text">
          {q.header && <span className="chat-question-chip">{q.header}</span>}
          {q.question}
        </div>
        <div className="chat-question-options">
          {q.options.map((opt) => {
            const on = picks[page].includes(opt.label)
            return (
              <button
                key={opt.label}
                className={`chat-question-option${on ? ' chat-question-option--on' : ''}`}
                onClick={() => toggle(page, opt.label)}
                title={opt.preview}
              >
                <span className="chat-question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="chat-question-option-desc">{opt.description}</span>
                )}
              </button>
            )
          })}
        </div>
        <input
          className="chat-question-other"
          placeholder="Something else…"
          value={other[page] ?? ''}
          onChange={(e) => setOther((prev) => ({ ...prev, [page]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // Enter finishes the question you are on; it only sends from the
            // last one, and only once every question has an answer.
            if (page < last) setPage(page + 1)
            else if (answered) send()
          }}
        />
        {q.multiSelect && <div className="chat-question-hint">Pick as many as apply</div>}
      </div>

      <div className="chat-question-actions">
        {page > 0 && (
          <Button size="compact" onClick={() => setPage(page - 1)}>
            Back
          </Button>
        )}
        {page < last ? (
          <Button intent="primary" size="compact" onClick={() => setPage(page + 1)}>
            Next
          </Button>
        ) : (
          <Button intent="primary" size="compact" disabled={!answered} onClick={send}>
            {questions.length > 1 ? 'Send answers' : 'Send answer'}
          </Button>
        )}
        {/* An unanswered question is the reason Send is disabled, and on the
            last page the one at fault can be several pages back — so say which. */}
        {page === last && !answered && (
          <span className="chat-question-hint">
            {(() => {
              const missing = questions[filled.findIndex((a) => a.length === 0)]
              return `Still needs an answer: ${missing.header || missing.question}`
            })()}
          </span>
        )}
        {/* Walking away has to reach the model as *something*, or the turn sits
            here forever waiting on a card the user is done with. */}
        <Button
          className="chat-question-skip"
          size="compact"
          onClick={() =>
            onDecide(requestId, {
              behavior: 'deny',
              message: 'The user skipped the question. Continue without an answer.'
            })
          }
        >
          Skip
        </Button>
      </div>
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

    case 'tool': {
      // The plan panel renders these calls as one list; their own chips would
      // repeat it a row at a time. An approval still shows — a suppressed chip
      // that is waiting on you is a turn that appears to have stalled.
      if (isPlanTool(item.call.name) && item.call.status !== 'awaiting') return null
      if (item.call.status !== 'awaiting') return <ToolChip call={item.call} home={home} />
      // A tool that answers on its own card gets that card — but only when its
      // arguments really are a question set, so an unrecognised interactive
      // tool still gets a prompt rather than an empty dialog.
      const questions = item.call.requiresUserInteraction
        ? parseAskQuestions(item.call.input)
        : null
      return questions ? (
        <QuestionCard call={item.call} questions={questions} onDecide={onDecide} />
      ) : (
        <ApprovalCard call={item.call} home={home} onDecide={onDecide} />
      )
    }

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
