import { Plus, X } from 'lucide-react'
import type { ITheme } from '@xterm/xterm'
import { TerminalPane } from '../TerminalPane'
import { IconButton } from '../ui'

export interface ShellTabInfo {
  termId: number
  label: string
  root: string
  exited: boolean
}

interface ShellWorkspaceProps {
  /** The selected project's shells — what the tab bar lists. */
  tabs: ShellTabInfo[]
  /** Every open shell, including other projects'. A terminal's scrollback
   *  lives in its xterm instance, so every pane stays mounted (hidden) for as
   *  long as its process does; unmounting one throws its output away. */
  panes: ShellTabInfo[]
  activeId: number | null
  theme: ITheme
  onActivate: (termId: number) => void
  onClose: (termId: number) => void
  onNew: () => void
  /** Right-click on New shell: pick a checkout instead of following the session. */
  onNewMenu: (at: { x: number; y: number }) => void
  /** Tooltip for New shell — it names the checkout the click opens in. */
  newLabel: string
  onOpenFile: (path: string, goto?: { line: number; col?: number }) => void
}

export function ShellWorkspace({
  tabs,
  panes,
  activeId,
  theme,
  onActivate,
  onClose,
  onNew,
  onNewMenu,
  newLabel,
  onOpenFile
}: ShellWorkspaceProps): React.JSX.Element {
  return (
    <div className="shell-workspace">
      <div className="shell-tab-bar" role="tablist" aria-label="Open shells">
        {tabs.map((tab) => (
          <div
            key={tab.termId}
            className={`shell-tab ${tab.termId === activeId ? 'shell-tab-active' : ''} ${tab.exited ? 'shell-tab-exited' : ''}`}
            title={tab.root}
            role="tab"
            aria-selected={tab.termId === activeId}
            tabIndex={tab.termId === activeId ? 0 : -1}
            onClick={() => onActivate(tab.termId)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onActivate(tab.termId)
            }}
          >
            <span className="shell-tab-label">{tab.label}</span>
            <button
              type="button"
              className="shell-tab-close"
              aria-label="Close shell"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.termId)
              }}
            >
              <X size={13} strokeWidth={1.75} />
            </button>
          </div>
        ))}
        <IconButton
          label={newLabel}
          dense
          className="shell-tab-new"
          onClick={onNew}
          onContextMenu={(event) => {
            event.preventDefault()
            onNewMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <Plus size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
      <div className="shell-pane-stack">
        {panes.map((pane) => (
          <TerminalPane
            key={pane.termId}
            termId={pane.termId}
            root={pane.root}
            theme={theme}
            onOpenFile={onOpenFile}
            active={pane.termId === activeId}
          />
        ))}
        {tabs.length === 0 && (
          <div className="shell-empty">
            <span>No shells open</span>
            <button
              type="button"
              className="btn btn--secondary btn--compact"
              onClick={onNew}
              onContextMenu={(event) => {
                event.preventDefault()
                onNewMenu({ x: event.clientX, y: event.clientY })
              }}
            >
              New shell
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
