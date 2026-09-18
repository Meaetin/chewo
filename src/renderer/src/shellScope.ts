/**
 * Which shells a session shows.
 *
 * A shell is where you check a branch by hand, so it belongs to the session
 * you opened it from rather than to the project: two sessions in one project
 * are usually on two branches, and one shared list meant running the tests for
 * the wrong one. A shell opened with no session focused has no owner and stays
 * a project shell, visible from every session — otherwise focusing a session
 * would hide a running process with nothing to say where it went.
 */

export interface ShellPane {
  paneId: number
  projectId: string | null
  /** The session that opened it; absent means a project shell */
  ownerPaneId?: number
}

/**
 * The focused session's own shells, then the project's unowned ones. A shell
 * belonging to another session is left out — focusing that session is how you
 * reach it, and its count is on the Shell tool's badge meanwhile.
 */
export function visibleShells<T extends ShellPane>(
  shells: T[],
  focusedPaneId: number | null,
  projectId: string | null
): T[] {
  const mine = shells.filter(
    (shell) => focusedPaneId !== null && shell.ownerPaneId === focusedPaneId
  )
  const shared = shells.filter(
    (shell) => shell.ownerPaneId === undefined && shell.projectId === projectId
  )
  return [...mine, ...shared]
}

/** Every shell a session owns — what closing it has to take with it. */
export function ownedShells<T extends ShellPane>(shells: T[], paneId: number): T[] {
  return shells.filter((shell) => shell.ownerPaneId === paneId)
}
