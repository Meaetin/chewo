import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { keymap, Prec, type Extension } from '@uiw/react-codemirror'
import { Code2, Eye, X } from 'lucide-react'
import type { ReadFileResult } from '../../../main/file-explorer'
import type { OpenFile } from '../App'
import { ImageStage } from './ImageStage'
import { languageFor } from '../theme/langs'
import { IconButton } from './ui'

interface FileEditorProps {
  visible: boolean
  /** Chips — the current section's open files */
  openFiles: OpenFile[]
  /** Union across all sections — buffers and watches span section switches */
  allOpenPaths: string[]
  activePath: string | null
  onActivate: (path: string) => void
  /** Appearance-driven CodeMirror theme (chrome + syntax highlighting) */
  theme: Extension
  onCloseFile: (path: string) => void
  /** Back to the terminal layer (Esc / chip strip empty) */
  onExit: () => void
}

interface FileBuffer {
  kind: 'text' | 'image'
  /** The working copy shown in CodeMirror — mutated on each keystroke */
  content: string
  /** data: URL, kind 'image' only */
  image?: string
  mtimeMs: number
  /** Unreadable file (binary / too large / gone) — placeholder instead of CM */
  error?: string
  /** Working copy differs from disk */
  dirty: boolean
  /** Dirty AND the file changed on disk underneath — needs a decision */
  conflict: boolean
  /** Last ⌘S, to ignore the watcher echo of our own write */
  savedAt: number
  saveError?: string
  /** SVG only: rendered preview instead of the code */
  svgPreview?: boolean
}

const isSvg = (path: string): boolean => path.toLowerCase().endsWith('.svg')

const bufferFrom = (res: ReadFileResult, path: string): FileBuffer => ({
  kind: res.ok ? res.kind : 'text',
  content: res.ok && res.kind === 'text' ? res.content : '',
  image: res.ok && res.kind === 'image' ? res.dataUrl : undefined,
  mtimeMs: res.ok ? res.mtimeMs : 0,
  error: res.ok ? undefined : res.error,
  dirty: false,
  conflict: false,
  savedAt: 0,
  // SVGs open rendered; the chip-bar toggle flips to code
  svgPreview: isSvg(path) || undefined
})

/** Our own save comes back as a watcher event within this window */
const SAVE_ECHO_MS = 1500

/**
 * The editor layer over the terminal: chip strip of open files + read-only
 * CodeMirror. Buffers live in a ref keyed by absolute path and the component
 * never unmounts, so switching sessions or toggling panels loses nothing.
 */
export function FileEditor({
  visible,
  openFiles,
  allOpenPaths,
  activePath,
  theme,
  onActivate,
  onCloseFile,
  onExit
}: FileEditorProps): React.JSX.Element {
  const buffers = useRef(new Map<string, FileBuffer>())
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])
  const watchId = useRef<number | null>(null)
  const watched = useRef(new Set<string>())
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath

  // Load the active file on first activation
  useEffect(() => {
    if (!activePath || buffers.current.has(activePath)) return
    let stale = false
    void window.api.fsReadFile(activePath).then((res) => {
      if (stale) return
      buffers.current.set(activePath, bufferFrom(res, activePath))
      bump()
    })
    return () => {
      stale = true
    }
  }, [activePath, bump])

  const reload = useCallback(
    (path: string) => {
      void window.api.fsReadFile(path).then((res) => {
        // Keep the preview mode across reloads of the same SVG
        const prev = buffers.current.get(path)
        buffers.current.set(path, { ...bufferFrom(res, path), svgPreview: prev?.svgPreview })
        bump()
      })
    },
    [bump]
  )

  const save = useCallback(() => {
    const path = activePathRef.current
    const buf = path ? buffers.current.get(path) : undefined
    if (!path || !buf || buf.error || buf.kind === 'image') return
    void window.api.fsWriteFile({ path, content: buf.content }).then((res) => {
      if (res.ok) {
        buf.mtimeMs = res.mtimeMs
        buf.dirty = false
        buf.conflict = false
        buf.savedAt = Date.now()
        buf.saveError = undefined
      } else {
        buf.saveError = res.error
      }
      bump()
    })
  }, [bump])

  // Keep buffers and the watch set in sync with every section's open files.
  // The single watcher is created lazily on the first open file and lives for
  // the app session (this component never unmounts).
  useEffect(() => {
    const open = new Set(allOpenPaths)
    for (const path of buffers.current.keys()) {
      if (!open.has(path)) buffers.current.delete(path)
    }
    const sync = (id: number): void => {
      for (const path of open) {
        if (!watched.current.has(path)) {
          window.api.fsWatchAdd(id, path)
          watched.current.add(path)
        }
      }
      for (const path of [...watched.current]) {
        if (!open.has(path)) {
          window.api.fsWatchRemove(id, path)
          watched.current.delete(path)
        }
      }
    }
    if (watchId.current !== null) {
      sync(watchId.current)
      return
    }
    if (open.size === 0) return
    let cancelled = false
    void window.api.fsWatch().then((id) => {
      if (cancelled) {
        window.api.fsUnwatch(id)
        return
      }
      watchId.current = id
      sync(id)
    })
    return () => {
      cancelled = true
    }
  }, [allOpenPaths])

  // External change to an open file. Clean buffer → silent reload (agents
  // rewrite files constantly; following the disk is the point). Dirty buffer
  // → conflict bar, never a modal. Our own save echo is ignored.
  useEffect(() => {
    return window.api.onFsChanged(({ watchId: id, paths }) => {
      if (id !== watchId.current) return
      for (const path of paths) {
        const buf = buffers.current.get(path)
        if (!buf) continue
        if (!buf.dirty) {
          reload(path)
        } else if (Date.now() - buf.savedAt > SAVE_ECHO_MS && !buf.conflict) {
          buf.conflict = true
          bump()
        }
      }
    })
  }, [bump, reload])

  const extensions = useMemo<Extension[]>(() => {
    const keys = Prec.high(
      keymap.of([
        {
          key: 'Escape',
          run: () => {
            onExit()
            return true
          }
        },
        {
          key: 'Mod-s',
          run: () => {
            save()
            return true
          }
        }
      ])
    )
    const lang = activePath ? languageFor(activePath.split('/').pop() ?? '') : null
    return lang ? [keys, lang] : [keys]
  }, [activePath, onExit, save])

  const buffer = activePath ? buffers.current.get(activePath) : undefined

  return (
    <div className="file-editor" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="file-chip-bar">
        {openFiles.map((f) => (
          <div
            key={f.path}
            className={`file-chip ${f.path === activePath ? 'file-chip-active' : ''}`}
            title={f.path}
            onClick={() => onActivate(f.path)}
          >
            {buffers.current.get(f.path)?.dirty && <span className="file-chip-dirty" />}
            <span className="file-chip-name">{f.name}</span>
            <IconButton
              label="Close file"
              dense
              className="file-chip-close"
              onClick={(e) => {
                e.stopPropagation()
                onCloseFile(f.path)
              }}
            >
              <X size={13} strokeWidth={1.75} />
            </IconButton>
          </div>
        ))}
        {buffer && activePath && isSvg(activePath) && !buffer.error && (
          <div className="file-chip-bar-actions">
            <IconButton
              label={buffer.svgPreview ? 'Show code' : 'Preview SVG'}
              dense
              onClick={() => {
                buffer.svgPreview = !buffer.svgPreview
                bump()
              }}
            >
              {buffer.svgPreview ? (
                <Code2 size={14} strokeWidth={1.75} />
              ) : (
                <Eye size={14} strokeWidth={1.75} />
              )}
            </IconButton>
          </div>
        )}
      </div>
      {buffer?.conflict && activePath && (
        <div className="file-editor-conflict-bar">
          <span className="file-editor-conflict-text">
            Changed on disk while you were editing
          </span>
          <button className="file-editor-conflict-action" onClick={() => reload(activePath)}>
            Reload
          </button>
          <button
            className="file-editor-conflict-action"
            onClick={() => {
              buffer.conflict = false
              bump()
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {buffer?.saveError && (
        <div className="file-editor-conflict-bar">
          <span className="file-editor-conflict-text">Save failed: {buffer.saveError}</span>
        </div>
      )}
      <div className="file-editor-body">
        {buffer?.error ? (
          <div className="file-editor-placeholder">
            <p>{buffer.error}</p>
          </div>
        ) : buffer?.kind === 'image' ? (
          <ImageStage src={buffer.image ?? ''} alt={activePath ?? ''} active={visible} />
        ) : buffer && activePath && isSvg(activePath) && buffer.svgPreview ? (
          <ImageStage
            src={`data:image/svg+xml;utf8,${encodeURIComponent(buffer.content)}`}
            alt={activePath}
            active={visible}
          />
        ) : buffer ? (
          <CodeMirror
            className="file-editor-cm"
            value={buffer.content}
            theme={theme}
            height="100%"
            extensions={extensions}
            onCreateEditor={() => bump()}
            basicSetup={{ highlightActiveLine: false, highlightActiveLineGutter: false }}
            onChange={(value) => {
              const buf = activePath ? buffers.current.get(activePath) : undefined
              if (!buf) return
              buf.content = value
              // bump only on the clean→dirty flip — the chip dot; CM owns its doc
              if (!buf.dirty) {
                buf.dirty = true
                bump()
              }
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
