import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { IconButton } from '../ui'

/**
 * The composer. Enter sends, Shift+Enter breaks a line — the convention every
 * chat app shares, and the opposite of the terminal it stands in for.
 *
 * The `/` palette is fed from the catalog the CLI reports at startup rather
 * than a list we maintain, so a user's own commands, skills and plugins show up
 * without Chewo knowing they exist.
 */

interface ChatComposerProps {
  busy: boolean
  disabled: boolean
  /** Names only, no leading slash */
  slashCommands: string[]
  placeholder: string
  onSend: (text: string) => void
  onInterrupt: () => void
}

export function ChatComposer({
  busy,
  disabled,
  slashCommands,
  placeholder,
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
            label="Send (↵)"
            className="chat-send"
            disabled={disabled || !value.trim()}
            onClick={submit}
          >
            <ArrowUp size={16} strokeWidth={2} />
          </IconButton>
        )}
      </div>
    </div>
  )
}
