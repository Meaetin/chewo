import { useEffect, useState } from 'react'
import { AlignLeft, Image as ImageIcon, Plus, Trash2, X } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { Button, IconButton } from './ui'
import {
  TODO_STATUSES,
  TODO_STATUS_LABELS,
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
  onClearDone: () => void
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
  onClearDone
}: TodoBoardProps): React.JSX.Element {
  const [dragOver, setDragOver] = useState<TodoStatus | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [addingIn, setAddingIn] = useState<TodoStatus | null>(null)
  const [editing, setEditing] = useState<TodoCard | null>(null)

  // A rescan (move/delete from another surface) can outdate the open modal
  useEffect(() => {
    if (editing && board && !board.cards[editing.id]) setEditing(null)
  }, [board, editing])

  if (!board) return <div className="todo-board" />

  return (
    <div className="todo-board">
      <header className="todo-board-header">
        <h2 className="todo-board-title">{scopeName}</h2>
        {board.columns.done.length > 0 && (
          <Button size="compact" onClick={onClearDone}>
            Clear done
          </Button>
        )}
      </header>

      <div className="todo-columns">
        {TODO_STATUSES.map((status) => {
          const ids = board.columns[status]
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
                <span className="todo-column-count">{ids.length}</span>
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
                    onSubmit={(title) => onAddCard(title, status)}
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
                      {(card.text || card.images?.length) && (
                        <span className="todo-card-indicators">
                          {card.text && <AlignLeft size={12} strokeWidth={1.75} />}
                          {!!card.images?.length && (
                            <>
                              <ImageIcon size={12} strokeWidth={1.75} />
                              {card.images.length > 1 && card.images.length}
                            </>
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

      {editing && (
        <TodoCardModal
          scopeDir={scopeDir}
          card={editing}
          onSave={onUpdateCard}
          onDelete={() => onDeleteCard(editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
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
  onSave,
  onDelete,
  onClose
}: {
  scopeDir: string
  card: TodoCard
  onSave: (args: UpdateCardPayload) => Promise<void>
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

  const save = async (): Promise<void> => {
    setSaving(true)
    await onSave({
      cardId: card.id,
      title,
      text,
      addImages: staged.map((s) => s.base64),
      removeImages: [...removed]
    })
    onClose()
  }

  const visibleExisting = existing.filter((i) => !removed.has(i.name))

  return (
    <ModalShell
      title="Edit card"
      subtitle="Paste an image into the text box to attach it"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button
            intent="danger"
            disabled={saving}
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
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button intent="primary" loading={saving} loadingText="Saving…" onClick={() => void save()}>
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
