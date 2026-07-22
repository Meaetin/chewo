import { useEffect, useState } from 'react'
import type { RepoStatus } from '../../main/git'

/**
 * Live repo status for one root: initial fetch, then refetch on every
 * git:changed from a main-process watcher (worktree + .git/HEAD + refs +
 * index, debounced there). Never cached across roots — agents mutate these
 * repos from outside the app.
 */
export function useGitStatus(root: string | null): RepoStatus | null {
  const [status, setStatus] = useState<RepoStatus | null>(null)

  useEffect(() => {
    setStatus(null)
    if (!root) return
    let cancelled = false
    let watchId: number | null = null

    const refresh = (): void => {
      void window.api.gitStatus(root).then((s) => {
        if (!cancelled) setStatus(s)
      })
    }
    refresh()

    void window.api.gitWatch(root).then((id) => {
      if (cancelled) {
        if (id !== -1) window.api.gitUnwatch(id)
        return
      }
      watchId = id
    })
    const off = window.api.onGitChanged(({ watchId: id }) => {
      if (id === watchId) refresh()
    })

    return () => {
      cancelled = true
      off()
      if (watchId !== null && watchId !== -1) window.api.gitUnwatch(watchId)
    }
  }, [root])

  return status
}

const DIRTY_POLL_MS = 15_000

/**
 * Uncommitted-change count for a root, polled — no filesystem watcher. Cheap
 * enough for the passive per-worktree pills on session tabs, where a 15s lag
 * is fine and a recursive watcher per worktree would not be.
 */
export function useGitDirtyCount(root: string | null): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    setCount(0)
    if (!root) return
    let cancelled = false
    const poll = (): void => {
      void window.api.gitStatus(root).then((s) => {
        if (!cancelled) setCount(s.ok && s.isRepo ? s.files.length : 0)
      })
    }
    poll()
    const timer = setInterval(poll, DIRTY_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [root])

  return count
}
