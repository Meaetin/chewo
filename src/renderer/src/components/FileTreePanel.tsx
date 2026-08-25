import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, PanelLeftClose } from 'lucide-react'
import type { DirEntry } from '../../../main/file-explorer'
import type { FileDisposition } from '../fileTabs'
import { ContextMenu, IconButton, type ContextMenuEntry } from './ui'

interface FileTreePanelProps {
  visible: boolean
  /** Effective root for the focused session — worktree path when isolated. */
  root: string
  /** Header text — basename of the root, ⎇-prefixed for worktrees */
  rootLabel: string
  activePath: string | null
  onOpenFile: (path: string, disposition: FileDisposition) => void
  onCollapse: () => void
  onError: (message: string) => void
  /** Successful trash — App closes any chips at/under the path */
  onDeleted: (path: string) => void
  /** Successful rename or move — App re-points any chips at/under the old path */
  onRenamed: (oldPath: string, newPath: string) => void
}

/** Expansion + directory cache for one root, kept across root switches. */
interface TreeState {
  expanded: Set<string>
  entries: Map<string, DirEntry[]>
}

/** A path marked with ⌘C / ⌘X, consumed by ⌘V */
interface Clipboard {
  path: string
  mode: 'copy' | 'cut'
}

/** Right-click target — `entry: null` means the empty space below the rows. */
interface MenuState {
  x: number
  y: number
  entry: DirEntry | null
}

/** Inline draft row for a not-yet-created file or folder. */
interface Draft {
  dir: string
  isDir: boolean
  value: string
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** Marks a drag as ours — external file drags carry 'Files' instead. */
const PATH_MIME = 'application/x-chewo-path'
/** Hover-to-open delay for collapsed folders during a drag */
const SPRING_MS = 600

/**
 * Lazy file tree: one fs:readDir per expanded directory, nothing recursive.
 * State is a ref keyed by root so flipping between a worktree tab and the
 * main checkout swaps trees instantly with both expansion states intact.
 *
 * Keyboard (panel focused): ⌘C copy, ⌘X cut, ⌘V paste into the selected dir
 * (or the selected file's dir), ⌘⌫ move to Trash, Enter rename inline.
 * Right-click a row — or the empty space below — for the same operations
 * plus New File / New Folder, Duplicate, Copy Path and Reveal in Finder.
 * Rows drag to move (⌥ to copy), with spring-loaded folders.
 */
export function FileTreePanel({
  visible,
  root,
  rootLabel,
  activePath,
  onOpenFile,
  onCollapse,
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
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  /** Directory the current drag would land in — highlighted while hovering */
  const [dropDir, setDropDir] = useState<string | null>(null)
  const renameInput = useRef<HTMLInputElement | null>(null)
  const draftInput = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // dataTransfer.getData() is unreadable during dragover, so the source path
  // is mirrored here for the validity checks that run on every hover
  const dragSrc = useRef<string | null>(null)
  const spring = useRef<{ dir: string; timer: ReturnType<typeof setTimeout> } | null>(null)

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
    setDraft(null)
    setMenu(null)
  }, [root])

  // Nothing below the panel should keep a menu open once it hides
  useEffect(() => {
    if (!visible) setMenu(null)
  }, [visible])

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

  const expandDir = (dirPath: string): void => {
    if (tree.expanded.has(dirPath)) return
    tree.expanded.add(dirPath)
    if (watchId.current !== null) window.api.fsWatchAdd(watchId.current, dirPath)
    if (!tree.entries.has(dirPath)) void loadDir(root, dirPath)
    bump()
  }

  const toggleDir = (dirPath: string): void => {
    if (!tree.expanded.has(dirPath)) {
      expandDir(dirPath)
      return
    }
    tree.expanded.delete(dirPath)
    if (watchId.current !== null) window.api.fsWatchRemove(watchId.current, dirPath)
    bump()
  }

  // ---------- file operations ----------

  /** The directory an operation lands in: the entry itself, or its parent. */
  const dirFor = (entry: DirEntry | null): string =>
    entry ? (entry.isDir ? entry.path : parentOf(entry.path)) : root

  /** Shared by ⌘V and drag-and-drop: land `srcPath` in `destDir`. */
  const transfer = async (
    srcPath: string,
    destDir: string,
    mode: 'copy' | 'cut',
    verb: string
  ): Promise<void> => {
    const res =
      mode === 'cut'
        ? await window.api.fsMove({ srcPath, destDir })
        : await window.api.fsCopy({ srcPath, destDir })
    if (!res.ok) {
      onError(`${verb} failed: ${res.error}`)
      return
    }
    if (mode === 'cut') {
      // Chips pointing at the moved file (or anything under a moved dir)
      // follow it rather than going stale
      onRenamed(srcPath, res.path)
      setSelected((s) => (s?.path === srcPath ? null : s))
      void loadDir(root, parentOf(srcPath))
    }
    if (destDir !== root) expandDir(destDir)
    void loadDir(root, destDir)
  }

  const doPaste = async (destDir: string): Promise<void> => {
    const src = clipboard
    if (!src) return
    if (src.mode === 'cut') setClipboard(null)
    await transfer(src.path, destDir, src.mode, 'Paste')
  }

  const doDelete = async (target: DirEntry | null): Promise<void> => {
    if (!target) return
    const res = await window.api.fsDelete(target.path)
    if (!res.ok) {
      onError(`Delete failed: ${res.error}`)
      return
    }
    setSelected((s) => (s?.path === target.path ? null : s))
    setClipboard((c) => (c?.path === target.path ? null : c))
    onDeleted(target.path)
    void loadDir(root, parentOf(target.path))
  }

  const doDuplicate = async (target: DirEntry): Promise<void> => {
    const destDir = parentOf(target.path)
    const res = await window.api.fsCopy({ srcPath: target.path, destDir })
    if (!res.ok) onError(`Duplicate failed: ${res.error}`)
    else void loadDir(root, destDir)
  }

  const doReveal = async (path: string): Promise<void> => {
    const res = await window.api.fsReveal(path)
    if (!res.ok) onError(`Reveal failed: ${res.error}`)
  }

  // ---------- drag and drop ----------
  //
  // Drop lands in a *directory*: a folder row takes the drop itself, a file
  // row passes it to its parent, and the empty space below the rows is the
  // root. Move by default, copy while ⌥ is held — Finder's grammar.

  const cancelSpring = (): void => {
    if (spring.current) clearTimeout(spring.current.timer)
    spring.current = null
  }

  /** Spring-loaded folders: hovering a collapsed dir opens it mid-drag. */
  const armSpring = (entry: DirEntry): void => {
    if (!entry.isDir || tree.expanded.has(entry.path)) {
      cancelSpring()
      return
    }
    if (spring.current?.dir === entry.path) return
    cancelSpring()
    spring.current = {
      dir: entry.path,
      timer: setTimeout(() => {
        spring.current = null
        expandDir(entry.path)
      }, SPRING_MS)
    }
  }

  const canDrop = (srcPath: string, destDir: string, copy: boolean): boolean => {
    if (destDir === srcPath || destDir.startsWith(srcPath + '/')) return false
    // A move into the folder it already sits in is a no-op; a copy isn't
    return copy || parentOf(srcPath) !== destDir
  }

  const endDrag = (): void => {
    cancelSpring()
    dragSrc.current = null
    setDragging(null)
    setDropDir(null)
  }

  /** Shared by rows and the empty space; `entry` is null for the root. */
  const onDragOverTarget = (e: React.DragEvent, entry: DirEntry | null): void => {
    const src = dragSrc.current
    // Anything without our MIME is a foreign drag (a file from Finder) —
    // leave it alone rather than pretending the tree can take it
    if (!src || !e.dataTransfer.types.includes(PATH_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    const destDir = dirFor(entry)
    if (!canDrop(src, destDir, e.altKey)) {
      e.dataTransfer.dropEffect = 'none'
      setDropDir(null)
      cancelSpring()
      return
    }
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
    setDropDir(destDir)
    if (entry) armSpring(entry)
    else cancelSpring()
  }

  const onDropTarget = (e: React.DragEvent, entry: DirEntry | null): void => {
    const src = e.dataTransfer.getData(PATH_MIME) || dragSrc.current
    if (!src) return
    e.preventDefault()
    e.stopPropagation()
    const destDir = dirFor(entry)
    const copy = e.altKey
    endDrag()
    if (!canDrop(src, destDir, copy)) return
    void transfer(src, destDir, copy ? 'copy' : 'cut', copy ? 'Copy' : 'Move')
  }

  // Never leave a spring timer running past unmount
  useEffect(() => cancelSpring, [])

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

  /** Open an inline draft row inside `dir`, expanding it first if needed. */
  const startCreate = (dir: string, isDir: boolean): void => {
    if (dir !== root) expandDir(dir)
    setRenaming(null)
    setDraft({ dir, isDir, value: '' })
  }

  const commitCreate = async (): Promise<void> => {
    const d = draft
    setDraft(null)
    if (!d) return
    const name = d.value.trim()
    if (!name) return
    const res = await window.api.fsCreate({ dirPath: d.dir, name, isDir: d.isDir })
    if (!res.ok) {
      onError(`Create failed: ${res.error}`)
      return
    }
    void loadDir(root, d.dir)
    if (d.isDir) expandDir(res.path)
    else onOpenFile(res.path, 'pinned')
  }

  const onPanelKeyDown = (e: React.KeyboardEvent): void => {
    if (renaming || draft) return // the inline input owns the keyboard
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'c') {
      if (selected) setClipboard({ path: selected.path, mode: 'copy' })
    } else if (mod && e.key.toLowerCase() === 'x') {
      if (selected) setClipboard({ path: selected.path, mode: 'cut' })
    } else if (mod && e.key.toLowerCase() === 'v') {
      void doPaste(dirFor(selected))
    } else if ((mod && e.key === 'Backspace') || e.key === 'Delete') {
      void doDelete(selected)
    } else if (e.key === 'Enter') {
      if (selected) setRenaming({ path: selected.path, value: selected.name })
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  // ---------- context menu ----------

  const menuItems = (entry: DirEntry | null): ContextMenuEntry[] => {
    const canPaste = clipboard !== null
    if (!entry)
      return [
        { id: 'newFile', label: 'New File' },
        { id: 'newFolder', label: 'New Folder' },
        { separator: true },
        { id: 'paste', label: 'Paste', shortcut: '⌘V', disabled: !canPaste },
        { separator: true },
        { id: 'copyPath', label: 'Copy Path' },
        { id: 'reveal', label: 'Reveal in Finder' }
      ]
    return [
      ...(entry.isDir
        ? ([
            { id: 'newFile', label: 'New File' },
            { id: 'newFolder', label: 'New Folder' },
            { separator: true }
          ] satisfies ContextMenuEntry[])
        : ([{ id: 'open', label: 'Open' }, { separator: true }] satisfies ContextMenuEntry[])),
      { id: 'cut', label: 'Cut', shortcut: '⌘X' },
      { id: 'copy', label: 'Copy', shortcut: '⌘C' },
      ...(entry.isDir
        ? ([
            { id: 'paste', label: 'Paste', shortcut: '⌘V', disabled: !canPaste }
          ] satisfies ContextMenuEntry[])
        : []),
      { id: 'duplicate', label: 'Duplicate' },
      { separator: true },
      { id: 'copyPath', label: 'Copy Path' },
      { id: 'reveal', label: 'Reveal in Finder' },
      { separator: true },
      { id: 'rename', label: 'Rename', shortcut: '⏎' },
      { id: 'delete', label: 'Move to Trash', shortcut: '⌘⌫', danger: true }
    ]
  }

  const onMenuSelect = (id: string): void => {
    const entry = menu?.entry ?? null
    setMenu(null)
    panelRef.current?.focus()
    const path = entry?.path ?? root
    switch (id) {
      case 'open':
        if (entry) onOpenFile(entry.path, 'pinned')
        break
      case 'newFile':
        startCreate(dirFor(entry), false)
        break
      case 'newFolder':
        startCreate(dirFor(entry), true)
        break
      case 'cut':
        if (entry) setClipboard({ path: entry.path, mode: 'cut' })
        break
      case 'copy':
        if (entry) setClipboard({ path: entry.path, mode: 'copy' })
        break
      case 'paste':
        void doPaste(dirFor(entry))
        break
      case 'duplicate':
        if (entry) void doDuplicate(entry)
        break
      case 'copyPath':
        navigator.clipboard.writeText(path).catch(() => onError('Copy path failed'))
        break
      case 'reveal':
        void doReveal(path)
        break
      case 'rename':
        if (entry) setRenaming({ path: entry.path, value: entry.name })
        break
      case 'delete':
        void doDelete(entry)
        break
    }
  }

  const openMenu = (e: React.MouseEvent, entry: DirEntry | null): void => {
    e.preventDefault()
    e.stopPropagation()
    setSelected(entry)
    setMenu({ x: e.clientX, y: e.clientY, entry })
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

  // The draft row mounts empty — just take focus
  useEffect(() => {
    if (draft) draftInput.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.dir, draft?.isDir])

  const draftRow = (depth: number): React.JSX.Element => (
    <div className="file-tree-row" key="__draft" style={{ paddingLeft: `${8 + depth * 14}px` }}>
      {draft?.isDir ? (
        <ChevronRight className="file-tree-caret" size={13} strokeWidth={1.75} />
      ) : (
        <span className="file-tree-caret-spacer" />
      )}
      <input
        ref={draftInput}
        className="file-tree-rename-input"
        placeholder={draft?.isDir ? 'Folder name' : 'File name'}
        value={draft?.value ?? ''}
        onChange={(e) => setDraft((d) => (d ? { ...d, value: e.target.value } : d))}
        onBlur={() => void commitCreate()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') void commitCreate()
          else if (e.key === 'Escape') setDraft(null)
        }}
      />
    </div>
  )

  const renderRows = (dirPath: string, depth: number): React.JSX.Element[] => {
    const entries = tree.entries.get(dirPath)
    const rows = (entries ?? []).flatMap((entry) => {
      const expanded = entry.isDir && tree.expanded.has(entry.path)
      const isRenaming = renaming?.path === entry.path
      const row = (
        <div
          key={entry.path}
          className={[
            'file-tree-row',
            entry.path === activePath ? 'file-tree-row-active' : '',
            entry.path === selected?.path ? 'file-tree-row-selected' : '',
            clipboard?.mode === 'cut' && clipboard.path === entry.path
              ? 'file-tree-row-cut'
              : '',
            entry.path === dragging ? 'file-tree-row-dragging' : '',
            entry.isDir && entry.path === dropDir ? 'file-tree-row-drop' : '',
            entry.isIgnored ? 'file-tree-row-ignored' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          draggable={!isRenaming}
          onDragStart={(e) => {
            e.dataTransfer.setData(PATH_MIME, entry.path)
            // Also as text so a path can be dragged into a terminal or editor
            e.dataTransfer.setData('text/plain', entry.path)
            e.dataTransfer.effectAllowed = 'copyMove'
            dragSrc.current = entry.path
            setDragging(entry.path)
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => onDragOverTarget(e, entry)}
          onDrop={(e) => onDropTarget(e, entry)}
          onClick={(event) => {
            setSelected(entry)
            if (entry.isDir) toggleDir(entry.path)
            else onOpenFile(entry.path, event.detail > 1 ? 'pinned' : 'preview')
          }}
          onContextMenu={(e) => openMenu(e, entry)}
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
    // Draft sits at the top of its directory so it's visible without scrolling
    if (draft?.dir === dirPath) rows.unshift(draftRow(depth))
    return rows
  }

  return (
    <div
      ref={panelRef}
      className="file-tree-panel"
      style={{ display: visible ? 'flex' : 'none' }}
      tabIndex={0}
      onKeyDown={onPanelKeyDown}
    >
      <div className="file-tree-header">
        <span className="file-tree-root-label" title={root}>
          {rootLabel}
        </span>
        <IconButton label="Collapse explorer (⌘⇧B)" dense onClick={onCollapse}>
          <PanelLeftClose size={14} strokeWidth={1.75} />
        </IconButton>
      </div>
      <div
        className={`file-tree-list ${dropDir === root ? 'file-tree-list-drop' : ''}`}
        onContextMenu={(e) => openMenu(e, null)}
        onDragOver={(e) => onDragOverTarget(e, null)}
        onDrop={(e) => onDropTarget(e, null)}
        onDragLeave={(e) => {
          // Ignore bubbles from moving between rows still inside the list
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDropDir(null)
          cancelSpring()
        }}
      >
        {renderRows(root, 0)}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.entry)}
          onSelect={onMenuSelect}
          onClose={() => {
            setMenu(null)
            panelRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
