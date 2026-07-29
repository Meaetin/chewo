import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { ContextMenu, IconButton, Row, type ContextMenuEntry } from './ui'
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
  /** Rename a subject or topic folder — resolves to an error message, or null */
  onRenameItem: (path: string, newName: string) => Promise<string | null>
  onDeleteItem: (path: string) => void
}

type Adding = { kind: 'subject' } | { kind: 'topic'; subject: string }

/** What a right-click targeted: one subject or topic row. */
interface MenuTarget {
  kind: 'subject' | 'topic'
  name: string
  path: string
  /** Topics for a subject, notes for a topic — drives the delete warning */
  childCount: number
}

/** Inline name input used for new subjects/topics and for renames. */
function NameInput({
  placeholder,
  initialValue = '',
  onSubmit,
  onCancel
}: {
  placeholder: string
  initialValue?: string
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)

  // Renames start with the old name selected, so typing replaces it
  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const submit = async (): Promise<void> => {
    if (submitted.current) return
    if (!value.trim() || value.trim() === initialValue.trim()) {
      onCancel()
      return
    }
    submitted.current = true
    const err = await onSubmit(value)
    if (err) {
      submitted.current = false
      setError(err)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="notes-add">
      <input
        ref={inputRef}
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
 * main panel. Right-click a subject or topic to rename it or move it to Trash;
 * a focused row takes ⏎ (rename) and ⌘⌫ / ⌦ (trash) directly.
 */
export function NotesSidebar({
  tree,
  selected,
  onSelectTopic,
  onCreateSubject,
  onCreateTopic,
  onRenameItem,
  onDeleteItem
}: NotesSidebarProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(selected ? [selected.subject] : [])
  )
  const [adding, setAdding] = useState<Adding | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)

  // Rows unmount while renaming and remount under a new path afterwards, so
  // focus is restored by path once the row is back in the DOM.
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const [focusPath, setFocusPath] = useState<string | null>(null)
  useEffect(() => {
    if (!focusPath) return
    rowRefs.current.get(focusPath)?.focus()
    setFocusPath(null)
  }, [focusPath, tree])

  const rowRef =
    (path: string) =>
    (el: HTMLDivElement | null): void => {
      if (el) rowRefs.current.set(path, el)
      else rowRefs.current.delete(path)
    }

  const toggleSubject = (name: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const openMenu = (e: React.MouseEvent, target: MenuTarget): void => {
    e.preventDefault()
    e.stopPropagation()
    setAdding(null)
    setRenaming(null)
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const menuItems: ContextMenuEntry[] = [
    { id: 'rename', label: 'Rename', shortcut: '⏎' },
    { id: 'delete', label: 'Move to Trash', shortcut: '⌘⌫', danger: true }
  ]

  /** Non-empty folders confirm — Trash is reversible, a lost lesson isn't obvious. */
  const requestDelete = (target: MenuTarget): void => {
    const noun = target.kind === 'subject' ? 'topic' : 'lesson'
    const what = `${target.childCount} ${noun}${target.childCount === 1 ? '' : 's'}`
    if (
      target.childCount > 0 &&
      !window.confirm(`Move "${target.name}" and its ${what} to the Trash?`)
    )
      return
    onDeleteItem(target.path)
  }

  const onMenuSelect = (id: string): void => {
    const target = menu?.target
    setMenu(null)
    if (!target) return
    if (id === 'rename') setRenaming(target.path)
    else requestDelete(target)
  }

  /** ⏎ rename, ⌘⌫ / ⌦ trash — the file tree's bindings, same meaning here. */
  const onRowKeyDown = (e: React.KeyboardEvent, target: MenuTarget): void => {
    if (e.key === 'Enter') setRenaming(target.path)
    else if ((e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) || e.key === 'Delete')
      requestDelete(target)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const renameInput = (path: string, name: string): React.JSX.Element => (
    <NameInput
      placeholder="Name…"
      initialValue={name}
      onCancel={() => {
        setRenaming(null)
        setFocusPath(path)
      }}
      onSubmit={async (value) => {
        const err = await onRenameItem(path, value)
        if (err) return err
        setRenaming(null)
        // The folder moved — focus its new path, not the one that just went away
        setFocusPath(path.slice(0, path.lastIndexOf('/') + 1) + value.trim())
        return null
      }}
    />
  )

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
          const subjectTarget: MenuTarget = {
            kind: 'subject',
            name: s.name,
            path: s.path,
            childCount: s.topics.length
          }
          return (
            <div key={s.path} className="project-section">
              {renaming === s.path ? (
                renameInput(s.path, s.name)
              ) : (
                <Row
                  ref={rowRef(s.path)}
                  selected={selected?.subject === s.name}
                  tone="alt"
                  onClick={() => toggleSubject(s.name)}
                  onContextMenu={(e) => openMenu(e, subjectTarget)}
                  onKeyDown={(e) => onRowKeyDown(e, subjectTarget)}
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
              )}

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
                    if (renaming === t.path)
                      return <div key={t.path}>{renameInput(t.path, t.name)}</div>
                    const topicTarget: MenuTarget = {
                      kind: 'topic',
                      name: t.name,
                      path: t.path,
                      childCount: t.notes.length
                    }
                    return (
                      <Row
                        key={t.path}
                        ref={rowRef(t.path)}
                        density="compact"
                        selected={isSelected}
                        onClick={() => onSelectTopic({ subject: s.name, topic: t.name })}
                        onContextMenu={(e) => openMenu(e, topicTarget)}
                        onKeyDown={(e) => onRowKeyDown(e, topicTarget)}
                      >
                        <span className="notes-row-line" title={t.path}>
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onSelect={onMenuSelect}
          onClose={() => {
            // The menu took focus on open — hand it back so ⏎/⌘⌫ still work
            setFocusPath(menu.target.path)
            setMenu(null)
          }}
        />
      )}
    </aside>
  )
}
