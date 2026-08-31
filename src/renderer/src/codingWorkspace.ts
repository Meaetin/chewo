import type { Source } from '../../shared/adapter/types'

/** Render-ready facts for a live agent pane. Shell ptys never enter this interface. */
export interface LiveSessionPane {
  paneId: number
  projectId: string | null
  source: Source
  title: string
  sessionId?: string
  pending: boolean
  exited: boolean
  /** The isolated checkout this pane runs in — its row stands in for that branch */
  worktreeId?: string
  worktreeLabel?: string
}

/** Live panes not yet represented by the transcript scan, newest first. */
export function unrepresentedLivePanes(
  panes: LiveSessionPane[],
  transcriptIds: Set<string>,
  projectId: string | null
): LiveSessionPane[] {
  return panes
    .filter((pane) => pane.projectId === projectId)
    .filter((pane) => !pane.sessionId || !transcriptIds.has(pane.sessionId))
    .sort((a, b) => b.paneId - a.paneId)
}

export function livePaneBySession(
  panes: LiveSessionPane[],
  sessionId: string
): LiveSessionPane | undefined {
  return panes.find((pane) => pane.sessionId === sessionId)
}
