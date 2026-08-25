/**
 * Folding a run of tool calls into one row.
 *
 * A turn that reads twelve files and runs nine commands is twelve plus nine
 * full-width chips, and the prose that gives them meaning scrolls off between
 * them — the mechanism buries the story. Consecutive calls are collected into
 * one summary row ("Ran 9 commands") that opens onto the chips, so the thread
 * reads as what the agent said and the tools stay a click away.
 *
 * Pure and DOM-free, like `tabStrip.ts` and `selectPlacement.ts`: what folds is
 * decided here and pinned by tests, and the renderer only draws the result.
 */

import type { ChatItem, ToolCall } from './agent-chat'
import { isPlanTool } from './tool-tasks'

export type ChatRow =
  | { kind: 'item'; id: string; item: ChatItem }
  | { kind: 'tools'; id: string; items: Array<{ id: string; call: ToolCall }> }

/**
 * Two chips are not a wall, and folding them costs a click to read what was
 * already on screen. Three is where a run starts to bury the prose around it.
 */
export const MIN_GROUP = 3

/**
 * Whether a call may be swallowed by a group. Three kinds never are, and each
 * for its own reason: an `awaiting` call is a question blocking the turn, a
 * patch or an image *is* the result worth seeing (Chewo opens both by default,
 * and hiding them behind two clicks would undo that), and a failure is the one
 * outcome you go looking for.
 */
export function foldable(call: ToolCall): boolean {
  if (call.status === 'awaiting' || call.status === 'error' || call.status === 'denied') return false
  return !call.patch && !(call.images && call.images.length > 0)
}

/**
 * The plan panel draws every `Task*` call as one list, so their chips render as
 * nothing — but an invisible item still *separates* two runs of real ones, and
 * a group split by something with no pixels reads as an accident. They are
 * dropped here instead, except when one is waiting on an approval.
 */
const invisible = (item: ChatItem): boolean =>
  item.kind === 'tool' && isPlanTool(item.call.name) && item.call.status !== 'awaiting'

export function groupChatItems(items: ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = []
  let run: Array<{ id: string; call: ToolCall }> = []

  const flush = (): void => {
    if (run.length === 0) return
    if (run.length >= MIN_GROUP) rows.push({ kind: 'tools', id: `tools:${run[0].id}`, items: run })
    else
      for (const t of run)
        rows.push({ kind: 'item', id: t.id, item: { kind: 'tool', id: t.id, call: t.call } })
    run = []
  }

  for (const item of items) {
    if (invisible(item)) continue
    if (item.kind === 'tool' && foldable(item.call)) {
      run.push({ id: item.id, call: item.call })
      continue
    }
    flush()
    rows.push({ kind: 'item', id: item.id, item })
  }
  flush()
  return rows
}

/**
 * What a folded run says about itself. Commands are counted apart from
 * everything else because "Ran 9 commands" is a far better description of a
 * shell burst than "Used 9 tools" — which is what the CLIs' own clients say,
 * and it is right.
 */
export function groupSummary(calls: ToolCall[]): string {
  const commands = calls.filter((c) => c.name === 'Bash').length
  const others = calls.length - commands
  // "a tool" rather than "1 tool": a count of one is a number nobody needed.
  const plural = (n: number, one: string, many: string): string =>
    n === 1 ? `a ${one}` : `${n} ${many}`
  const ran = commands > 0 ? `Ran ${plural(commands, 'command', 'commands')}` : ''
  const used = others > 0 ? `${ran ? 'used' : 'Used'} ${plural(others, 'tool', 'tools')}` : ''
  return [ran, used].filter(Boolean).join(', ')
}
