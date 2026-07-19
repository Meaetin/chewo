import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { IconButton, Row } from './ui'
import type { NotesTree } from '../../../shared/notes'

export interface TopicRef {
  subject: string
  topic: string
}

interface NotesSidebarProps {
  tree: NotesTree | null
  selected: TopicRef | null
  onSelectTopic: (ref: TopicRef) => void
  onCreateSubject: (name: string) => Promise<string | null>
  onCreateTopic: (subject: string, name: string) => Promise<string | null>
}

type Adding = { kind: 'subject' } | { kind: 'topic'; subject: string }

/** Inline name input used for both new subjects and new topics. */
function NameInput({
  placeholder,
  onSubmit,
  onCancel
}: {
  placeholder: string
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (!value.trim()) {
      onCancel()
      return
    }
    const err = await onSubmit(value)
    if (err) setError(err)
  }
  return (
    <div className="notes-add">
      <input
        className="notes-add-input"
        autoFocus
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => void submit()}
      />
      {error && <div className="notes-add-error">{error}</div>}
    </div>
  )
}

/**
 * OneNote-style navigation: subjects (notebooks) expand to topics (sections).
 * Selecting a topic opens its workspace — the page list + editor — in the
 * main panel.
 */
export function NotesSidebar({
  tree,
  selected,
  onSelectTopic,
  onCreateSubject,
  onCreateTopic
}: NotesSidebarProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(selected ? [selected.subject] : [])
  )
  const [adding, setAdding] = useState<Adding | null>(null)

  const toggleSubject = (name: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const subjects = tree?.subjects ?? []

  return (
    <aside className="sidebar notes-sidebar">
      <div className="project-rail-header">
        <span>Subjects</span>
        <IconButton
          label="New subject (e.g. Cooking class, Maths)"
          dense
          onClick={() => setAdding({ kind: 'subject' })}
        >
          <Plus />
        </IconButton>
      </div>

      <div className="session-list">
        {adding?.kind === 'subject' && (
          <NameInput
            placeholder="Subject name…"
            onCancel={() => setAdding(null)}
            onSubmit={async (name) => {
              const err = await onCreateSubject(name)
              if (!err) {
                setAdding(null)
                setExpanded((prev) => new Set(prev).add(name.trim()))
              }
              return err
            }}
          />
        )}

        {subjects.map((s) => {
          const isExpanded = expanded.has(s.name)
          const noteCount = s.topics.reduce((n, t) => n + t.notes.length, 0)
          return (
            <div key={s.path} className="project-section">
              <Row
                selected={selected?.subject === s.name}
                tone="alt"
                onClick={() => toggleSubject(s.name)}
                leading={
                  <span className="notes-row-chevron">
                    {isExpanded ? <ChevronDown /> : <ChevronRight />}
                  </span>
                }
                trailing={
                  <IconButton
                    label="New topic in this subject (e.g. Lesson 1, Algebra)"
                    dense
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpanded((prev) => new Set(prev).add(s.name))
                      setAdding({ kind: 'topic', subject: s.name })
                    }}
                  >
                    <Plus />
                  </IconButton>
                }
              >
                <span className="notes-row-line" title={s.path}>
                  <span className="notes-row-name">{s.name}</span>
                  <span className="notes-row-count">{noteCount}</span>
                </span>
              </Row>

              {isExpanded && (
                <div className="project-sessions">
                  {adding?.kind === 'topic' && adding.subject === s.name && (
                    <NameInput
                      placeholder="Topic name…"
                      onCancel={() => setAdding(null)}
                      onSubmit={async (name) => {
                        const err = await onCreateTopic(s.name, name)
                        if (!err) {
                          setAdding(null)
                          onSelectTopic({ subject: s.name, topic: name.trim() })
                        }
                        return err
                      }}
                    />
                  )}
                  {s.topics.map((t) => {
                    const isSelected =
                      selected?.subject === s.name && selected?.topic === t.name
                    return (
                      <Row
                        key={t.path}
                        density="compact"
                        selected={isSelected}
                        onClick={() => onSelectTopic({ subject: s.name, topic: t.name })}
                      >
                        <span className="notes-row-line">
                          <span className="notes-row-name">{t.name}</span>
                          <span className="notes-row-count">{t.notes.length}</span>
                        </span>
                      </Row>
                    )
                  })}
                  {s.topics.length === 0 && adding?.kind !== 'topic' && (
                    <div className="session-list-empty">No topics yet — add one with the + button.</div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {subjects.length === 0 && adding?.kind !== 'subject' && (
          <div className="session-list-empty">
            No subjects yet — create one with the + button above. Subjects hold topics; topics
            hold your notes.
          </div>
        )}
      </div>
    </aside>
  )
}
