import { sessionInSection, type Project, type Worktree } from '../../shared/projects'
import type { SessionMeta } from '../../shared/adapter/types'

/** How many recent prompts a pending pane's empty state offers to repeat */
const MAX_SUGGESTED = 3

/**
 * The most recent conversations for a pending pane's project, to fill the
 * composer with rather than typing from scratch. Reuses the sidebar's own
 * `sessionInSection` matching (a session counts if it ran in the project's
 * checkout *or* one of its worktrees) so this list and the sidebar can never
 * disagree about which sessions belong where. `project` absent means Home.
 */
export function suggestedPrompts(
  sessions: SessionMeta[],
  project: Project | undefined,
  worktrees: Worktree[],
  homeDir: string
): string[] {
  const inScope = project
    ? sessions.filter((s) => sessionInSection(s.project, project, worktrees))
    : sessions.filter((s) => s.project === homeDir)
  return [...inScope]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SUGGESTED)
    .map((s) => s.title)
}
