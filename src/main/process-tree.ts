import { execFileSync } from 'node:child_process'

/**
 * Killing a pane kills the process Chewo spawned and nothing beneath it.
 *
 * That gap is not theoretical: an agent's background task once left eight
 * `while :; do :; done` subshells running for sixteen days, because its
 * cleanup line never ran and the shells had already been detached with `&`.
 * Closing the pane killed `claude`; the loops were adopted by launchd.
 *
 * So a pane's descendants are collected and signalled *before* the pane's own
 * process dies — once the parent is gone the tree is unrecoverable, since a
 * reparented process keeps no record of who started it.
 *
 * The one case this cannot catch is a child that calls `setsid` to detach
 * immediately: it is already an orphan before we ever look.
 */

export interface ProcRow {
  pid: number
  ppid: number
}

/** Guard against a malformed table: a cycle would otherwise walk forever. */
const MAX_DEPTH = 32

/**
 * Every process below `roots`, deepest first — so a parent is never signalled
 * before its own children, which would let them reparent and escape the sweep.
 *
 * Pure, so the walk is testable without spawning anything.
 */
export function collectDescendants(rows: ProcRow[], roots: number[]): number[] {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    if (row.pid <= 1 || row.ppid <= 0) continue
    const kids = children.get(row.ppid)
    if (kids) kids.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }

  const out: number[] = []
  const seen = new Set<number>(roots)

  const walk = (pid: number, depth: number): void => {
    if (depth > MAX_DEPTH) return
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      walk(child, depth + 1)
      out.push(child)
    }
  }

  for (const root of roots) {
    if (root > 1) walk(root, 0)
  }
  return out
}

/** `ps` output to rows. Tolerant of blank and malformed lines. */
export function parseProcessTable(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]) })
  }
  return rows
}

/**
 * Read synchronously: the quit path runs inside `will-quit`, where a promise
 * has no guarantee of ever settling. It costs about 10ms.
 */
function readProcessTable(): ProcRow[] {
  try {
    return parseProcessTable(execFileSync('/bin/ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }))
  } catch {
    return []
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  // Never signal init, the whole group (pid 0), or ourselves — a malformed
  // table must not be able to turn this into a self-kill.
  if (pid <= 1 || pid === process.pid) return
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone, or not ours to signal. Both are fine.
  }
}

const GRACE_MS = 1500

/**
 * Terminate everything below `roots`, leaving the roots themselves to the
 * caller — node-pty and child_process each have their own `kill()` that does
 * more than a bare signal (closing the pty, ending stdin), so they stay in
 * charge of their own process.
 *
 * `immediate` skips the grace period for the app-quit path, where there is no
 * later tick to run the follow-up sweep in.
 */
export function killDescendants(
  roots: number | number[],
  opts: { immediate?: boolean } = {}
): void {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(
    (pid) => Number.isInteger(pid) && pid > 1
  )
  if (list.length === 0) return

  const doomed = collectDescendants(readProcessTable(), list)
  if (doomed.length === 0) return

  for (const pid of doomed) signal(pid, 'SIGTERM')

  if (opts.immediate) {
    for (const pid of doomed) signal(pid, 'SIGKILL')
    return
  }

  // Anything still alive after the grace period ignored SIGTERM (or is a
  // spin loop that never reached a handler). Re-check rather than blanket
  // SIGKILL, so a pid recycled onto a new process is not hit.
  const timer = setTimeout(() => {
    const alive = new Set(readProcessTable().map((row) => row.pid))
    for (const pid of doomed) if (alive.has(pid)) signal(pid, 'SIGKILL')
  }, GRACE_MS)
  timer.unref()
}
