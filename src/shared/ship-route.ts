/**
 * How work leaves a checkout, and the one rule that differs between the two.
 *
 * Shared because both sides need the same answer: `git-ship.ts` acts on it, and
 * `ShipModal` has to *say* what will happen before you press the button. A rule
 * this small is exactly the kind that drifts when it is written twice.
 */

export type ShipRoute = 'pr' | 'push'

/**
 * Whether shipping cuts a fresh branch before committing.
 *
 * Opening a PR never commits onto the repo's default, nor onto the branch the
 * PR lands in — either way the work moves onto a branch of its own first.
 *
 * Pushing straight onto the base inverts half of that: adding to the base is
 * the point, so standing on it is no reason to branch, and cutting one anyway
 * would put the commits on the remote while leaving the local branch behind
 * them. Standing on the repo default while pushing somewhere *else* still
 * branches — those commits were never meant for the shared checkout's branch,
 * and several agents are usually standing on it.
 */
export function willCutBranch(
  route: ShipRoute,
  branch: string,
  base: string,
  repoDefault: string
): boolean {
  if (route === 'push') return branch !== base && branch === repoDefault
  return branch === base || branch === repoDefault
}
