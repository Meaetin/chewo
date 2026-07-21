import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlignLeft,
  Archive,
  Image as ImageIcon,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { ModalShell } from './ModalShell'
import { Button, IconButton } from './ui'
import {
  TODO_STATUSES,
  TODO_STATUS_LABELS,
  type ArchivedCard,
  type BoardFile,
  type TodoCard,
  type TodoStatus
} from '../../../shared/todos'

const CARD_MIME = 'application/x-chewo-card'

export interface UpdateCardPayload {
  cardId: string
  title: string
  text: string
  addImages: string[]
  removeImages: string[]
}

interface TodoBoardProps {
  scopeDir: string
  scopeName: string
  board: BoardFile | null
  onAddCard: (title: string, status: TodoStatus) => void
  onMoveCard: (cardId: string, to: TodoStatus) => void
  onUpdateCard: (args: UpdateCardPayload) => Promise<void>
  onDeleteCard: (cardId: string) => void
  onArchiveDone: () => void
  /** Where a run lands — the project name, or "Home (~)" for General */
  runTargetLabel: string
  /** "Run in Claude" in the card modal → interactive Claude session (§10) */
  onRunCard: (cardId: string) => Promise<void>
  onFocusRun: (termId: number) => void
  /** cardId → termId of its latest run; renderer-only, dies with the app */
  runs: Map<string, number>
  liveTermIds: Set<number>
}

/** Case-insensitive substring over title + text — a filter, not a ranker. */
const matchesQuery = (card: TodoCard, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    card.title.toLowerCase().includes(q) || (card.text ?? '').toLowerCase().includes(q)
  )
}

/** Inline title input shown at the top of a column after "+ Add". */
function AddCardInput({
  onSubmit,
  onCancel
}: {
  onSubmit: (title: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const commit = (): void => {
    if (value.trim()) onSubmit(value)
    onCancel()
  }
  return (
    <input
      className="todo-add-input"
      autoFocus
      placeholder="Card title…"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={commit}
    />
  )
}

/**
 * The four-column kanban (SPEC-TODOS §5). Drag & drop is native HTML5: a
 * valid drop inserts at the top of the target column; dropping anywhere
 * else is a no-op (the browser snaps the ghost back for free).
 */
export function TodoBoard({
  scopeDir,
  scopeName,
  board,
  onAddCard,
  onMoveCard,
  onUpdateCard,
  onDeleteCard,
  onArchiveDone,
  runTargetLabel,
  onRunCard,
  onFocusRun,
  runs,
  liveTermIds
}: TodoBoardProps): React.JSX.Element {
  const [dragOver, setDragOver] = useState<TodoStatus | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [addingIn, setAddingIn] = useState<TodoStatus | null>(null)
  const [editing, setEditing] = useState<TodoCard | null>(null)
  const [query, setQuery] = useState('')
  const [showArchive, setShowArchive] = useState(false)
  const [archived, setArchived] = useState<ArchivedCard[]>([])

  // A rescan (move/delete from another surface) can outdate the open modal
  useEffect(() => {
    if (editing && board && !board.cards[editing.id]) setEditing(null)
  }, [board, editing])

  // The count in the header must survive archiving from any surface, so it
  // reloads whenever the board does
  const refreshArchive = useCallback(() => {
    void window.api.todosArchive(scopeDir).then((a) => setArchived(a.cards))
  }, [scopeDir])
  useEffect(refreshArchive, [refreshArchive, board])

  // Switching boards must not carry a filter across — the new board would
  // look half-empty for no visible reason
  useEffect(() => {
    setQuery('')
    setShowArchive(false)
  }, [scopeDir])

  const filtered = useMemo(() => {
    if (!board) return null
    return Object.fromEntries(
      TODO_STATUSES.map((status) => [
        status,
        board.columns[status].filter((id) => {
          const card = board.cards[id]
          return card && matchesQuery(card, query)
        })
      ])
    ) as Record<TodoStatus, string[]>
  }, [board, query])

  if (!board || !filtered) return <div className="todo-board" />

  const filtering = query.trim().length > 0
  /** The card's latest run, if that terminal is still open (§10.1). */
  const runningTerm = (cardId: string): number | null => {
    const termId = runs.get(cardId)
    return termId !== undefined && liveTermIds.has(termId) ? termId : null
  }
  const matchCount = TODO_STATUSES.reduce((n, status) => n + filtered[status].length, 0)

  return (
    <div className="todo-board">
      <header className="todo-board-header">
        <h2 className="todo-board-title">{scopeName}</h2>
        <div className="todo-board-search">
          <Search size={13} strokeWidth={1.75} className="todo-board-search-icon" />
          <input
            className="todo-board-search-input"
            placeholder="Filter cards…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {filtering && (
            <IconButton label="Clear filter" dense onClick={() => setQuery('')}>
              <X size={12} strokeWidth={2} />
            </IconButton>
          )}
        </div>
        {archived.length > 0 && (
          <Button
            size="compact"
            onClick={() => setShowArchive(true)}
            leadingIcon={<Archive size={13} strokeWidth={1.75} />}
          >
            Archived {archived.length}
          </Button>
        )}
        {board.columns.done.length > 0 && (
          <Button size="compact" onClick={onArchiveDone}>
            Archive done
          </Button>
        )}
      </header>

      <div className="todo-columns">
        {TODO_STATUSES.map((status) => {
          const ids = filtered[status]
          return (
            <section
              key={status}
              className={`todo-column ${dragOver === status ? 'todo-column-dragover' : ''}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(CARD_MIME)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOver(status)
              }}
              onDragLeave={(e) => {
                // Ignore bubbles from children still inside the column
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const cardId = e.dataTransfer.getData(CARD_MIME)
                if (cardId) onMoveCard(cardId, status)
              }}
            >
              <header className="todo-column-header">
                <span className={`todo-column-name todo-column-name--${status}`}>
                  {TODO_STATUS_LABELS[status]}
                </span>
                <span className="todo-column-count">
                  {filtering ? `${ids.length}/${board.columns[status].length}` : ids.length}
                </span>
                <IconButton
                  label={`Add card to ${TODO_STATUS_LABELS[status]}`}
                  dense
                  className="todo-column-add"
                  onClick={() => setAddingIn(status)}
                >
                  <Plus size={14} strokeWidth={1.75} />
                </IconButton>
              </header>

              <div className="todo-column-cards">
                {addingIn === status && (
                  <AddCardInput
                    onSubmit={(title) => {
                      // A new card that doesn't match the live filter would
                      // vanish on commit — drop the filter instead
                      setQuery('')
                      onAddCard(title, status)
                    }}
                    onCancel={() => setAddingIn(null)}
                  />
                )}
                {ids.map((id) => {
                  const card = board.cards[id]
                  if (!card) return null
                  return (
                    <article
                      key={id}
                      className={`todo-card ${draggingId === id ? 'todo-card-dragging' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(CARD_MIME, id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDraggingId(id)
                      }}
                      onDragEnd={() => {
                        setDraggingId(null)
                        setDragOver(null)
                      }}
                      onClick={() => setEditing(card)}
                    >
                      <span className="todo-card-title">{card.title}</span>
                      {(card.text || card.images?.length || runningTerm(id) !== null) && (
                        <span className="todo-card-indicators">
                          {card.text && <AlignLeft size={12} strokeWidth={1.75} />}
                          {!!card.images?.length && (
                            <>
                              <ImageIcon size={12} strokeWidth={1.75} />
                              {card.images.length > 1 && card.images.length}
                            </>
                          )}
                          {runningTerm(id) !== null && (
                            <button
                              type="button"
                              className="todo-card-run"
                              title="Jump to this card’s Claude session"
                              onClick={(e) => {
                                e.stopPropagation() // don't open the edit modal
                                onFocusRun(runningTerm(id)!)
                              }}
                            >
                              <Play size={10} strokeWidth={2.5} />
                            </button>
                          )}
                        </span>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>

      {filtering && matchCount === 0 && (
        <p className="todo-board-empty">
          No cards match “{query.trim()}”
          {archived.length > 0 && ' on this board — the archive isn’t searched'}.
        </p>
      )}

      {editing && (
        <TodoCardModal
          scopeDir={scopeDir}
          card={editing}
          runTargetLabel={runTargetLabel}
          runningTermId={runningTerm(editing.id)}
          onSave={onUpdateCard}
          onRun={onRunCard}
          onFocusRun={onFocusRun}
          onDelete={() => onDeleteCard(editing.id)}
          onClose={() => setEditing(null)}
        />
      )}

      {showArchive && (
        <ArchiveModal
          scopeName={scopeName}
          cards={archived}
          onRestore={async (cardId) => {
            await window.api.todosRestoreArchived({ scopeDir, cardId })
            refreshArchive()
          }}
          onDelete={async (cardId) => {
            const archive = await window.api.todosDeleteArchived({ scopeDir, cardId })
            setArchived(archive.cards)
          }}
          onEmpty={async () => {
            const archive = await window.api.todosEmptyArchive(scopeDir)
            setArchived(archive.cards)
          }}
          onClose={() => setShowArchive(false)}
        />
      )}
    </div>
  )
}

/**
 * The archive drawer (T4). "Archive done" is reversible by design, so this is
 * where restores live — and the only place a card can be destroyed, one
 * explicit confirm at a time.
 */
function ArchiveModal({
  scopeName,
  cards,
  onRestore,
  onDelete,
  onEmpty,
  onClose
}: {
  scopeName: string
  cards: ArchivedCard[]
  onRestore: (cardId: string) => Promise<void>
  onDelete: (cardId: string) => Promise<void>
  onEmpty: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [confirmingEmpty, setConfirmingEmpty] = useState(false)

  useEffect(() => {
    if (cards.length === 0) onClose()
  }, [cards.length, onClose])

  return (
    <ModalShell
      title={`${scopeName} archive`}
      subtitle="Cards retired from Done — restore puts one back at the top of Todo"
      onClose={onClose}
      footer={
        <>
          <Button
            intent="danger"
            onClick={() => {
              if (!confirmingEmpty) {
                setConfirmingEmpty(true)
                return
              }
              void onEmpty()
            }}
            leadingIcon={<Trash2 size={14} strokeWidth={1.75} />}
          >
            {confirmingEmpty ? `Really delete all ${cards.length}?` : 'Delete all'}
          </Button>
          <div className="wt-footer-spacer" />
          <Button intent="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <ul className="todo-archive-list">
        {cards.map((card) => (
          <li key={card.id} className="todo-archive-item">
            <div className="todo-archive-card">
              <span className="todo-archive-title">{card.title}</span>
              <span className="todo-archive-meta">
                archived {new Date(card.archivedAt).toLocaleDateString()}
                {card.images?.length ? ` · ${card.images.length} image` : ''}
                {(card.images?.length ?? 0) > 1 ? 's' : ''}
              </span>
            </div>
            <Button
              size="compact"
              onClick={() => void onRestore(card.id)}
              leadingIcon={<RotateCcw size={13} strokeWidth={1.75} />}
            >
              Restore
            </Button>
            <Button
              size="compact"
              intent="danger"
              onClick={() => {
                if (confirmingDelete !== card.id) {
                  setConfirmingDelete(card.id)
                  return
                }
                void onDelete(card.id)
              }}
            >
              {confirmingDelete === card.id ? 'Really?' : 'Delete'}
            </Button>
          </li>
        ))}
      </ul>
    </ModalShell>
  )
}

interface StagedImage {
  key: string
  dataUrl: string
  base64: string
}

/** Read a pasted image file as { dataUrl, base64 } for preview + IPC. */
const readImage = (file: File): Promise<StagedImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve({
        key: crypto.randomUUID(),
        dataUrl,
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1)
      })
    }
    reader.readAsDataURL(file)
  })

/**
 * Edit modal (SPEC-TODOS §5): explicit Save/Cancel — the one place in Chewo
 * without autosave. Images paste into the text box and stage locally;
 * nothing touches disk until Save.
 */
function TodoCardModal({
  scopeDir,
  card,
  runTargetLabel,
  runningTermId,
  onSave,
  onRun,
  onFocusRun,
  onDelete,
  onClose
}: {
  scopeDir: string
  card: TodoCard
  runTargetLabel: string
  runningTermId: number | null
  onSave: (args: UpdateCardPayload) => Promise<void>
  onRun: (cardId: string) => Promise<void>
  onFocusRun: (termId: number) => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(card.title)
  const [text, setText] = useState(card.text ?? '')
  const [existing, setExisting] = useState<Array<{ name: string; dataUrl: string | null }>>(
    (card.images ?? []).map((name) => ({ name, dataUrl: null }))
  )
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [staged, setStaged] = useState<StagedImage[]>([])
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let alive = true
    for (const name of card.images ?? []) {
      void window.api.todosReadAsset({ scopeDir, fileName: name }).then((dataUrl) => {
        if (alive && dataUrl)
          setExisting((imgs) => imgs.map((i) => (i.name === name ? { ...i, dataUrl } : i)))
      })
    }
    return () => {
      alive = false
    }
  }, [scopeDir, card.images])

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = [...e.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      void readImage(file).then((img) => setStaged((s) => [...s, img]))
    }
  }

  const commit = async (): Promise<void> => {
    await onSave({
      cardId: card.id,
      title,
      text,
      addImages: staged.map((s) => s.base64),
      removeImages: [...removed]
    })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    await commit()
    onClose()
  }

  /**
   * Run what's on screen: pending edits are saved first, so the prompt can
   * never be built from stale text the user has already rewritten. Closes
   * the modal — the toast reports where it landed, and the board stays put
   * so the next card can be written straight away.
   */
  const run = async (): Promise<void> => {
    setRunning(true)
    await commit()
    await onRun(card.id)
    onClose()
  }

  const visibleExisting = existing.filter((i) => !removed.has(i.name))

  return (
    <ModalShell
      title="Edit card"
      subtitle="Paste an image into the text box to attach it"
      busy={saving || running}
      onClose={onClose}
      footer={
        <>
          <Button
            intent="danger"
            disabled={saving || running}
            onClick={() => {
              if (!confirmingDelete) {
                setConfirmingDelete(true)
                return
              }
              onDelete()
              onClose()
            }}
            leadingIcon={<Trash2 size={14} strokeWidth={1.75} />}
          >
            {confirmingDelete ? 'Really delete?' : 'Delete'}
          </Button>
          <div className="wt-footer-spacer" />
          {runningTermId !== null && (
            <Button
              disabled={saving || running}
              onClick={() => onFocusRun(runningTermId)}
              leadingIcon={<Play size={13} strokeWidth={2} />}
            >
              Open session
            </Button>
          )}
          <Button
            disabled={saving || running}
            loading={running}
            loadingText="Starting…"
            onClick={() => void run()}
            title={`Start a Claude session in ${runTargetLabel} with this card as the prompt`}
            leadingIcon={<Play size={13} strokeWidth={2} />}
          >
            Run in Claude
          </Button>
          <Button disabled={saving || running} onClick={onClose}>
            Cancel
          </Button>
          <Button
            intent="primary"
            loading={saving}
            loadingText="Saving…"
            disabled={running}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="todo-modal-body">
        <input
          className="todo-modal-title"
          value={title}
          autoFocus
          placeholder="Title"
          onChange={(e) => setTitle(e.target.value)}
          onPaste={onPaste}
        />
        <textarea
          className="todo-modal-text"
          value={text}
          placeholder="Notes… (optional)"
          rows={6}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
        />
        {(visibleExisting.length > 0 || staged.length > 0) && (
          <div className="todo-modal-images">
            {visibleExisting.map((img) => (
              <figure key={img.name} className="todo-modal-image">
                {img.dataUrl ? (
                  <img src={img.dataUrl} alt="" />
                ) : (
                  <span className="todo-modal-image-loading" />
                )}
                <IconButton
                  label="Remove image"
                  dense
                  className="todo-modal-image-remove"
                  onClick={() => setRemoved((r) => new Set(r).add(img.name))}
                >
                  <X size={12} strokeWidth={2} />
                </IconButton>
              </figure>
            ))}
            {staged.map((img) => (
              <figure key={img.key} className="todo-modal-image">
                <img src={img.dataUrl} alt="" />
                <IconButton
                  label="Remove image"
                  dense
                  className="todo-modal-image-remove"
                  onClick={() => setStaged((s) => s.filter((i) => i.key !== img.key))}
                >
                  <X size={12} strokeWidth={2} />
                </IconButton>
              </figure>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  )
}
