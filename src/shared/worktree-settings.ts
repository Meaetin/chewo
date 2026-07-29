/**
 * Worktree lifecycle preferences.
 *
 * Isolated branches accumulate: one worktree per agent task, and a merged one
 * looks exactly like a live one in `git branch` — the branch survives the merge
 * that made it redundant, and its checkout keeps sitting in ~/.chewo/worktrees.
 * Cleaning up by hand means remembering to, so the merge modal offers to do it
 * at the one moment the work is provably finished.
 *
 * This is a preference, never a policy: the cleanup runs the same unforced
 * `git worktree remove` + `branch -d` the button runs, so git still refuses
 * anything that would lose work.
 */

export interface WorktreeSettings {
  /**
   * Remove the worktree and delete its branch as soon as a merge lands.
   *
   * On by default because a merge from this modal is an explicit act on a
   * branch git has just confirmed is clean and merged — the two conditions
   * that make removal safe. The merge modal still shows a per-merge checkbox,
   * so keeping a checkout around never requires a trip to settings.
   */
  autoCleanupOnMerge: boolean
}

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  autoCleanupOnMerge: true
}

export function normalizeWorktreeSettings(
  partial: Partial<WorktreeSettings> | undefined
): WorktreeSettings {
  return {
    autoCleanupOnMerge:
      typeof partial?.autoCleanupOnMerge === 'boolean'
        ? partial.autoCleanupOnMerge
        : DEFAULT_WORKTREE_SETTINGS.autoCleanupOnMerge
  }
}
