/**
 * Pane ids for both runtimes.
 *
 * A chat pane and a terminal pane are two ways to run the same thing, and the
 * renderer keys every tab, drag target, `paneTabs` entry and `MainView` by a
 * single number. Handing them out from one counter is what lets a session
 * switch between the two views without the tab strip knowing the difference —
 * and stops a chat pane's id from ever colliding with a terminal's.
 *
 * The renderer can take one too (`pane:reserve`): a session that hasn't been
 * started yet is a real tab with a composer and no process behind it, and it
 * needs an id from this same counter so that the pane it eventually becomes
 * can take its place without the strip seeing a collision.
 */
let next = 1

export function nextPaneId(): number {
  return next++
}
