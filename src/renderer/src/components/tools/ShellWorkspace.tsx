import { Plus, X } from 'lucide-react'
import type { MouseEvent } from 'react'
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
  tabs: ShellTabInfo[]
  activeId: number | null
  theme: ITheme
  onActivate: (termId: number) => void
  onClose: (termId: number) => void
  onNew: (event: MouseEvent<HTMLButtonElement>) => void
  onOpenFile: (path: string, goto?: { line: number; col?: number }) => void
}

export function ShellWorkspace({
  tabs,
  activeId,
  theme,
  onActivate,
  onClose,
  onNew,
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
        <IconButton label="New shell" dense className="shell-tab-new" onClick={onNew}>
          <Plus size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
      <div className="shell-pane-stack">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.termId}
            termId={tab.termId}
            root={tab.root}
            theme={theme}
            onOpenFile={onOpenFile}
            active={tab.termId === activeId}
          />
        ))}
        {tabs.length === 0 && (
          <div className="shell-empty">
            <span>No shells open</span>
            <button type="button" className="btn btn--secondary btn--compact" onClick={onNew}>
              New shell
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
