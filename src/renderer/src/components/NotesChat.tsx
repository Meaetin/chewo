import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TopicRef } from './NotesSidebar'

type Scope = 'all' | 'subject' | 'topic'

interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  text: string
}

interface NotesChatProps {
  /** Notes root directory (scope 'all') */
  root: string
  /** Current subject/topic selection — enables the narrower scopes */
  sel: TopicRef | null
  open: boolean
  onClose: () => void
}

interface ContentBlock {
  type: string
  text?: string
  name?: string
}

/**
 * Scoped Q&A over the notes corpus (SPEC-NOTES.md §9). Each conversation is
 * a headless Claude session whose cwd is the scope folder — the filesystem
 * IS the scope. Stays mounted while the notes workflow is up so history
 * survives collapse/expand; changing scope starts a fresh conversation.
 */
export function NotesChat({ root, sel, open, onClose }: NotesChatProps): React.JSX.Element {
  const [scope, setScope] = useState<Scope>('all')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const sessionId = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Narrow scopes only exist while a subject/topic is selected
  useEffect(() => {
    if (!sel && scope !== 'all') setScope('all')
  }, [sel, scope])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  useEffect(() => {
    const off = window.api.onNotesChatEvent((ev) => {
      const type = ev.type as string
      if (type === 'system' && (ev.subtype as string) === 'init') {
        sessionId.current = (ev.session_id as string) ?? null
        return
      }
      if (type === 'assistant') {
        const message = ev.message as { content?: ContentBlock[] } | undefined
        for (const block of message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            const text = block.text
            setStatus(null)
            setMessages((m) => {
              const last = m[m.length - 1]
              if (last?.role === 'assistant')
                return [...m.slice(0, -1), { role: 'assistant' as const, text: last.text + text }]
              return [...m, { role: 'assistant' as const, text }]
            })
          } else if (block.type === 'tool_use') {
            setStatus(`Searching notes (${block.name ?? 'tool'})…`)
          }
        }
        return
      }
      if (type === 'result') {
        setRunning(false)
        setStatus(null)
        if (ev.is_error)
          setMessages((m) => [...m, { role: 'error', text: 'The answer failed — try again.' }])
        return
      }
      if (type === 'chat_error') {
        setRunning(false)
        setStatus(null)
        setMessages((m) => [...m, { role: 'error', text: String(ev.message ?? 'Chat failed') }])
        return
      }
      if (type === 'chat_closed') {
        setRunning(false)
        setStatus(null)
      }
    })
    return () => {
      off()
    }
  }, [])

  const scopePath =
    scope === 'all' || !sel
      ? root
      : scope === 'subject'
        ? `${root}/${sel.subject}`
        : `${root}/${sel.subject}/${sel.topic}`

  const scopeLabel =
    scope === 'all' || !sel ? 'all notes' : scope === 'subject' ? sel.subject : `${sel.subject} / ${sel.topic}`

  const send = useCallback(() => {
    const message = input.trim()
    if (!message || running || !root) return
    setInput('')
    setRunning(true)
    setStatus('Thinking…')
    setMessages((m) => [...m, { role: 'user', text: message }])
    window.api.notesChatSend({
      scopePath,
      message,
      resumeSessionId: sessionId.current ?? undefined
    })
  }, [input, running, root, scopePath])

  const newChat = useCallback(() => {
    window.api.notesChatCancel()
    sessionId.current = null
    setMessages([])
    setRunning(false)
    setStatus(null)
  }, [])

  const changeScope = (next: Scope): void => {
    if (next === scope) return
    setScope(next)
    // cwd defines the conversation's world — changing it starts fresh
    newChat()
  }

  return (
    <div className="notes-chat" style={{ display: open ? 'flex' : 'none' }}>
      <div className="notes-chat-header">
        <span className="notes-chat-title">Ask your notes</span>
        <select
          className="notes-chat-scope"
          value={scope}
          onChange={(e) => changeScope(e.target.value as Scope)}
          title="Which notes the answer may draw from"
        >
          <option value="all">All notes</option>
          {sel && <option value="subject">{sel.subject}</option>}
          {sel && <option value="topic">{`${sel.subject} / ${sel.topic}`}</option>}
        </select>
        <button className="session-action-button" title="New conversation" onClick={newChat}>
          ⟳
        </button>
        <button className="session-action-button" title="Hide chat" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="notes-chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="session-list-empty">
            Ask anything across {scopeLabel} — “what did we cover about X?”, “summarize
            yesterday's lesson”. Answers cite the lessons they came from.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`notes-chat-msg notes-chat-msg-${m.role}`}>
            {m.role === 'assistant' ? (
              <div className="message-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              </div>
            ) : (
              m.text
            )}
          </div>
        ))}
        {status && <div className="notes-chat-status">{status}</div>}
      </div>

      <div className="notes-chat-input-row">
        <textarea
          className="notes-chat-input"
          placeholder={`Ask ${scopeLabel}…`}
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {running ? (
          <button
            className="notes-chat-send"
            title="Stop the answer"
            onClick={() => {
              window.api.notesChatCancel()
              setRunning(false)
              setStatus(null)
            }}
          >
            ■
          </button>
        ) : (
          <button className="notes-chat-send" title="Send (Enter)" onClick={send} disabled={!input.trim()}>
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
