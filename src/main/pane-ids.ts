/**
 * Pane ids for both runtimes.
 *
 * A chat pane and a terminal pane are two ways to run the same thing, and the
 * renderer keys every live pane and `MainView` by a single number. Handing them
 * out from one counter lets a session switch between the two runtimes without
 * changing its identity, and prevents collisions.
 *
 * The renderer can take one too (`pane:reserve`): a session that hasn't been
 * started yet is a real pane with a composer and no process behind it, and it
 * needs an id from this same counter so the runtime can take its place.
 */
let next = 1

export function nextPaneId(): number {
  return next++
}
