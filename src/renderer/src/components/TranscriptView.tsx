import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { NormalizedMessage, SessionMeta } from '../../../shared/adapter/types'

interface TranscriptViewProps {
  session: SessionMeta
  onResume: (session: SessionMeta) => void
}

export function TranscriptView({ session, onResume }: TranscriptViewProps): React.JSX.Element {
  const [messages, setMessages] = useState<NormalizedMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .getSession({ source: session.source, filePath: session.filePath })
      .then((result: { messages: NormalizedMessage[] }) => {
        if (!cancelled) setMessages(result.messages)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [session.source, session.filePath])

  return (
    <div className="transcript-view">
      <header className="transcript-header">
        <div className="transcript-header-info">
          <h2 className="transcript-title">{session.title}</h2>
          <div className="transcript-meta">
            <span className={`source-badge source-badge-${session.source}`}>
              {session.source === 'claude' ? 'Claude Code' : 'Codex'}
            </span>
            {session.project && <span className="transcript-project">{session.project}</span>}
            {session.gitBranch && <span className="transcript-branch">⎇ {session.gitBranch}</span>}
          </div>
        </div>
        <button className="resume-button" onClick={() => onResume(session)}>
          ▶ Resume
        </button>
      </header>

      <div className="transcript-messages">
        {error && <div className="transcript-error">{error}</div>}
        {!messages && !error && <div className="transcript-loading">Loading…</div>}
        {messages?.map((m, i) => (
          <div key={i} className={`message message-${m.role}`}>
            {m.commandName ? (
              <div className="command-chip" title="Slash command">
                <span className="command-chip-symbol">⌘</span>
                <code>{m.commandName}</code>
              </div>
            ) : m.role === 'tool' ? (
              <div className="tool-call-chip">
                <span className="tool-call-name">{m.toolName}</span>
                {m.text && <code className="tool-call-detail">{m.text.slice(0, 160)}</code>}
              </div>
            ) : m.role === 'assistant' ? (
              <>
                <div className="message-role-label">assistant</div>
                <div className="message-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                </div>
              </>
            ) : (
              // User text stays literal — pasted code/logs must not be
              // reinterpreted as markdown
              <>
                <div className="message-role-label">user</div>
                <div className="message-text">{m.text}</div>
              </>
            )}
          </div>
        ))}
        {messages?.length === 0 && <div className="transcript-loading">No messages</div>}
      </div>
    </div>
  )
}
