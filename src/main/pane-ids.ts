/**
 * Pane ids for both runtimes.
 *
 * A chat pane and a terminal pane are two ways to run the same thing, and the
 * renderer keys every tab, drag target, `paneTabs` entry and `MainView` by a
 * single number. Handing them out from one counter is what lets a session
 * switch between the two views without the tab strip knowing the difference —
 * and stops a chat pane's id from ever colliding with a terminal's.
 */
let next = 1

export function nextPaneId(): number {
  return next++
}
