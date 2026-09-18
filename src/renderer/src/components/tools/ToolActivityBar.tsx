import { FolderTree, GitBranch, Terminal } from 'lucide-react'
import { IconButton } from '../ui'
import { useKeybindLabel } from '../../keybinds'

export type CodingTool = 'files' | 'git' | 'shell'

interface ToolActivityBarProps {
  active: CodingTool | null
  gitEnabled: boolean
  dirtyCount: number
  /** Shells this session can see — its own, plus the project's unowned ones */
  shellCount: number
  onSelect: (tool: CodingTool) => void
}

/**
 * Lives inside the session header rather than in a column of its own: three
 * icons cost a strip of the header's spare width, where a rail cost 42px of
 * every workspace row for the whole session.
 */
export function ToolActivityBar({
  active,
  gitEnabled,
  dirtyCount,
  shellCount,
  onSelect
}: ToolActivityBarProps): React.JSX.Element {
  const toolsKey = useKeybindLabel('tools.toggle')
  return (
    <nav className="tool-activity-bar" aria-label="Coding tools">
      <IconButton
        label={`Files (${toolsKey})`}
        dense
        active={active === 'files'}
        onClick={() => onSelect('files')}
      >
        <FolderTree size={15} strokeWidth={1.75} />
      </IconButton>
      <IconButton
        label={gitEnabled ? 'Git — changes & history' : 'Git — select a project first'}
        dense
        active={active === 'git'}
        disabled={!gitEnabled}
        className="tool-activity-git"
        onClick={() => onSelect('git')}
      >
        <GitBranch size={15} strokeWidth={1.75} />
        {dirtyCount > 0 && (
          <span className="tool-activity-count">{dirtyCount > 99 ? '99+' : dirtyCount}</span>
        )}
      </IconButton>
      <IconButton
        label={
          shellCount > 0
            ? `Shell — ${shellCount} open in this session`
            : 'Shell — run commands in this session’s checkout'
        }
        dense
        active={active === 'shell'}
        onClick={() => onSelect('shell')}
      >
        <Terminal size={15} strokeWidth={1.75} />
        {shellCount > 0 && (
          <span className="tool-activity-count tool-activity-count--live">{shellCount}</span>
        )}
      </IconButton>
    </nav>
  )
}
