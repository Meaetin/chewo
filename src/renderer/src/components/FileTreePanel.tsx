import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import type { DirEntry } from '../../../main/file-explorer'
import { IconButton } from './ui'

interface FileTreePanelProps {
  visible: boolean
  /** Effective root for the active tab — worktree path when isolated */
  root: string
  /** Header text — basename of the root, ⎇-prefixed for worktrees */
  rootLabel: string
  activePath: string | null
  onOpenFile: (path: string) => void
  onClose: () => void
  onError: (message: string) => void
  /** Successful trash — App closes any chips at/under the path */
  onDeleted: (path: string) => void
  /** Successful rename — App re-points any chips at/under the old path */
  onRenamed: (oldPath: string, newPath: string) => void
}

/** Expansion + directory cache for one root, kept across root switches. */
interface TreeState {
  expanded: Set<string>
  entries: Map<string, DirEntry[]>
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/**
 * Lazy file tree: one fs:readDir per expanded directory, nothing recursive.
 * State is a ref keyed by root so flipping between a worktree tab and the
 * main checkout swaps trees instantly with both expansion states intact.
 *
 * Keyboard (panel focused): ⌘C copy, ⌘V paste into the selected dir (or the
 * selected file's dir), ⌘⌫ move to Trash, Enter rename inline.
 */
export function FileTreePanel({
  visible,
  root,
  rootLabel,
  activePath,
  onOpenFile,
  onClose,
  onError,
  onDeleted,
  onRenamed
}: FileTreePanelProps): React.JSX.Element {
  const trees = useRef(new Map<string, TreeState>())
  const [, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])
  const watchId = useRef<number | null>(null)
  // Live mirror for the fs:changed handler (registered once)
  const rootRef = useRef(root)
  rootRef.current = root

  const [selected, setSelected] = useState<DirEntry | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  /** Internal clipboard — a path marked with ⌘C, consumed by ⌘V */
  const clipboard = useRef<string | null>(null)
  const renameInput = useRef<HTMLInputElement | null>(null)

  const treeFor = (r: string): TreeState => {
    let t = trees.current.get(r)
    if (!t) {
      t = { expanded: new Set(), entries: new Map() }
      trees.current.set(r, t)
    }
    return t
  }
  const tree = treeFor(root)

  const loadDir = useCallback(
    async (r: string, dirPath: string) => {
      const res = await window.api.fsReadDir(dirPath)
      const t = treeFor(r)
      // Failed reads clear the cache entry so a re-expand retries
      if (res.ok) t.entries.set(dirPath, res.entries)
      else t.entries.delete(dirPath)
      bump()
    },
    [bump]
  )

  // Re-read the root and every expanded dir whenever the panel is shown or the
  // root flips. No live watcher runs while hidden, so external changes made in
  // that window (a file deleted from the terminal) would otherwise persist as
  // stale rows — reopening the panel now re-syncs against disk.
  useEffect(() => {
    if (!visible) return
    const t = treeFor(root)
    void loadDir(root, root)
    for (const dir of t.expanded) if (t.entries.has(dir)) void loadDir(root, dir)
  }, [visible, root, loadDir])

  // Selection belongs to the visible root
  useEffect(() => {
    setSelected(null)
    setRenaming(null)
  }, [root])

  // One depth-0 watcher while visible: the root + every expanded dir of the
  // current root. Torn down on hide/root-flip; stale events carry an old
  // watchId and are ignored below.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void window.api.fsWatch().then((id) => {
      if (cancelled) {
        window.api.fsUnwatch(id)
        return
      }
      watchId.current = id
      window.api.fsWatchAdd(id, root)
      for (const dir of treeFor(root).expanded) window.api.fsWatchAdd(id, dir)
    })
    return () => {
      cancelled = true
      if (watchId.current !== null) {
        window.api.fsUnwatch(watchId.current)
        watchId.current = null
      }
    }
  }, [visible, root])

  // A changed path refreshes its parent dir (and itself when it's an
  // expanded dir that got removed) — but only dirs already in the cache
  useEffect(() => {
    return window.api.onFsChanged(({ watchId: id, paths }) => {
      if (id !== watchId.current) return
      const t = treeFor(rootRef.current)
      const stale = new Set<string>()
      for (const p of paths) {
        const parent = parentOf(p)
        if (t.entries.has(parent)) stale.add(parent)
        if (t.entries.has(p)) stale.add(p)
      }
      for (const dir of stale) void loadDir(rootRef.current, dir)
    })
  }, [loadDir])

  const toggleDir = (dirPath: string): void => {
    if (tree.expanded.has(dirPath)) {
      tree.expanded.delete(dirPath)
      if (watchId.current !== null) window.api.fsWatchRemove(watchId.current, dirPath)
    } else {
      tree.expanded.add(dirPath)
      if (watchId.current !== null) window.api.fsWatchAdd(watchId.current, dirPath)
      if (!tree.entries.has(dirPath)) void loadDir(root, dirPath)
    }
    bump()
  }

  // ---------- keyboard file operations ----------

  const doPaste = async (): Promise<void> => {
    const src = clipboard.current
    if (!src) return
    const destDir = selected ? (selected.isDir ? selected.path : parentOf(selected.path)) : root
    const res = await window.api.fsCopy({ srcPath: src, destDir })
    if (!res.ok) onError(`Paste failed: ${res.error}`)
    else void loadDir(root, destDir)
  }

  const doDelete = async (): Promise<void> => {
    if (!selected) return
    const res = await window.api.fsDelete(selected.path)
    if (!res.ok) {
      onError(`Delete failed: ${res.error}`)
      return
    }
    setSelected(null)
    onDeleted(selected.path)
    void loadDir(root, parentOf(selected.path))
  }

  const commitRename = async (): Promise<void> => {
    const r = renaming
    setRenaming(null)
    if (!r) return
    const oldName = r.path.split('/').pop() ?? ''
    const newName = r.value.trim()
    if (!newName || newName === oldName) return
    const res = await window.api.fsRename({ path: r.path, newName })
    if (!res.ok) {
      onError(`Rename failed: ${res.error}`)
      return
    }
    setSelected((s) => (s && s.path === r.path ? { ...s, path: res.path, name: newName } : s))
    onRenamed(r.path, res.path)
    void loadDir(root, parentOf(r.path))
  }

  const onPanelKeyDown = (e: React.KeyboardEvent): void => {
    if (renaming) return // the rename input owns the keyboard
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'c') {
      if (selected) clipboard.current = selected.path
    } else if (mod && e.key.toLowerCase() === 'v') {
      void doPaste()
    } else if ((mod && e.key === 'Backspace') || e.key === 'Delete') {
      void doDelete()
    } else if (e.key === 'Enter') {
      if (selected) setRenaming({ path: selected.path, value: selected.name })
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  // Put the caret in the rename input when it appears, name-stem selected
  useEffect(() => {
    if (!renaming) return
    const input = renameInput.current
    if (!input) return
    input.focus()
    const dot = renaming.value.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : renaming.value.length)
    // Run once when the input mounts for this rename target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming?.path])

  const renderRows = (dirPath: string, depth: number): React.JSX.Element[] => {
    const entries = tree.entries.get(dirPath)
    if (!entries) return []
    return entries.flatMap((entry) => {
      const expanded = entry.isDir && tree.expanded.has(entry.path)
      const isRenaming = renaming?.path === entry.path
      const row = (
        <div
          key={entry.path}
          className={[
            'file-tree-row',
            entry.path === activePath ? 'file-tree-row-active' : '',
            entry.path === selected?.path ? 'file-tree-row-selected' : '',
            entry.isIgnored ? 'file-tree-row-ignored' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => {
            setSelected(entry)
            if (entry.isDir) toggleDir(entry.path)
            else onOpenFile(entry.path)
          }}
        >
          {entry.isDir ? (
            <ChevronRight
              className={`file-tree-caret ${expanded ? 'file-tree-caret-open' : ''}`}
              size={13}
              strokeWidth={1.75}
            />
          ) : (
            <span className="file-tree-caret-spacer" />
          )}
          {isRenaming ? (
            <input
              ref={renameInput}
              className="file-tree-rename-input"
              value={renaming.value}
              onChange={(e) => setRenaming({ path: entry.path, value: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') void commitRename()
                else if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <span className="file-tree-name">{entry.name}</span>
          )}
        </div>
      )
      return expanded ? [row, ...renderRows(entry.path, depth + 1)] : [row]
    })
  }

  return (
    <div
      className="file-tree-panel"
      style={{ display: visible ? 'flex' : 'none' }}
      tabIndex={0}
      onKeyDown={onPanelKeyDown}
    >
      <div className="file-tree-header">
        <span className="file-tree-root-label" title={root}>
          {rootLabel}
        </span>
        <IconButton label="Hide files (⌘⇧E)" dense onClick={onClose}>
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      </div>
      <div className="file-tree-list">{renderRows(root, 0)}</div>
    </div>
  )
}
