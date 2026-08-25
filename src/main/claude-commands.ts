import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { buildPtyEnv } from './terminals'
import { claudeChatArgs } from './claude-chat'

/**
 * The slash-command catalog for a checkout, read before any session runs in it.
 *
 * A pending pane has no process behind it — the agent, model and checkout are
 * only answerable once the task is typed — so it never receives the
 * `initialize` reply that `chat-sessions.ts` gets its command list from, and
 * its `/` menu was empty until the first message had already been sent.
 *
 * The handshake does not need *that* pane's process, though: any short-lived
 * one answers it. So this spawns a throwaway CLI, sends the same `initialize`
 * request, takes the reply and kills it. Measured on this repo: 1.3 s for 94
 * commands, no turn spent and no session file written (nothing is ever sent as
 * a user message, so the CLI has no conversation to file).
 *
 * Three rules, all for the same reason — this feeds a menu, so it may never be
 * something the composer waits on:
 *
 * 1. **Every failure returns `[]`**, which is exactly the state the pane was
 *    in before. A missing CLI, a timeout, a shape change: the menu stays empty
 *    and the real pane fills it in a moment later.
 * 2. **Keyed by cwd**, because the catalog is: a repo's own
 *    `.claude/commands/` is in it. Asking from the wrong directory would offer
 *    commands that do not exist there, which is worse than offering none.
 * 3. **The live pane still wins.** This is a fallback the composer uses only
 *    while `system/init` has not arrived; once the session speaks, its own
 *    catalog replaces this one.
 */

/** Our handshake id, matching the one `chat-sessions.ts` uses. */
const INIT_REQUEST_ID = 'chewo-init'

/**
 * Long enough for a cold CLI start (1.3 s warm here), short enough that a
 * hung spawn does not leave a process parked for the session's lifetime.
 */
const TIMEOUT_MS = 20_000

/**
 * Installing a plugin or writing a command file is a deliberate act in another
 * window, so a stale list for a minute costs nothing — and this is a process
 * spawn sitting on project selection. Same trade as `listInstalledPlugins`.
 */
const CACHE_MS = 60_000

const cached = new Map<string, { at: number; commands: string[] }>()
const inFlight = new Map<string, Promise<string[]>>()

export async function claudeSlashCommands(cwd?: string | null): Promise<string[]> {
  const dir = cwd && existsSync(cwd) ? cwd : homedir()
  const hit = cached.get(dir)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.commands
  const running = inFlight.get(dir)
  if (running) return running

  const read = probe(dir)
    .then((commands) => {
      // A failed probe is not cached: the next pane should try again rather
      // than inherit a minute of emptiness from one bad spawn.
      if (commands.length) cached.set(dir, { at: Date.now(), commands })
      return commands
    })
    .finally(() => {
      inFlight.delete(dir)
    })
  inFlight.set(dir, read)
  return read
}

function probe(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (commands: string[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.kill()
      resolve(commands)
    }

    // Same args and same `/bin/zsh -ilc` launch as a real chat pane, so this
    // sees the PATH and the CLI version an actual session would.
    const proc = spawn('/bin/zsh', ['-ilc', 'claude "$@"', 'chewo', ...claudeChatArgs({})], {
      cwd,
      env: buildPtyEnv(process.env)
    })

    const timer = setTimeout(() => finish([]), TIMEOUT_MS)
    proc.on('error', () => finish([]))
    // The CLI exiting before it answered is a failure like any other
    proc.on('exit', () => finish([]))

    let buffer = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          // The CLI prints the odd human banner before the JSONL starts
          continue
        }
        const reply = raw as {
          type?: string
          response?: { request_id?: string; response?: { commands?: Array<{ name?: string }> } }
        }
        if (reply.type !== 'control_response' || reply.response?.request_id !== INIT_REQUEST_ID)
          continue
        finish(
          (reply.response.response?.commands ?? [])
            .map((c) => c.name)
            .filter((n): n is string => Boolean(n))
        )
        return
      }
    })

    proc.stdin.on('error', () => finish([]))
    proc.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: INIT_REQUEST_ID,
        request: { subtype: 'initialize', hooks: {} }
      }) + '\n'
    )
  })
}
