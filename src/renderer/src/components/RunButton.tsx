import { Play } from 'lucide-react'
import { Tooltip } from './ui'
import { useKeybindLabel } from '../keybinds'

interface RunButtonProps {
  /** The project whose start command this runs */
  projectName: string
  /** What it will run — one shell per line */
  command: string
  /** Isolated checkout it will run in; absent means the project's own */
  worktreeLabel?: string
  onRun: () => void
}

/**
 * Runs the project's start command for the focused session.
 *
 * It sits beside Ship rather than on the sidebar's project row because the
 * question it answers is per session, not per project: with an isolated
 * session focused the dev server comes up in *that* session's checkout, which
 * is the shortest path from "the agent changed something" to seeing it. On the
 * project row the scope was invisible — the same glyph did two different
 * things depending on what happened to be focused elsewhere.
 *
 * Ports are deliberately not remapped, so two branches serving the same port
 * collide and the second one says so — quieter than silently serving the wrong
 * branch on the port you opened.
 */
export function RunButton({
  projectName,
  command,
  worktreeLabel,
  onRun
}: RunButtonProps): React.JSX.Element {
  const where = worktreeLabel ? `⎇ ${worktreeLabel}` : `${projectName}’s main checkout`
  const label = `Run ${command} in ${where} (${useKeybindLabel('session.run')})`

  return (
    <Tooltip label={label} side="top">
      <button type="button" className="run-button" aria-label={label} onClick={onRun}>
        <Play size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className="run-button-label">Run</span>
      </button>
    </Tooltip>
  )
}
