import type { ReactNode } from 'react'

/**
 * The body of whichever tool is open. Its picker is the header's
 * ToolActivityBar, so nothing is rendered here when no tool is selected.
 */
export function ToolsPanel({ children }: { children?: ReactNode }): React.JSX.Element {
  return <section className="tools-panel">{children}</section>
}
