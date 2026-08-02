/**
 * Chat-protocol canary — the sibling of `canary.ts`, for the *live* wire rather
 * than the session files on disk. Run after every CLI update:
 * `npm run canary:chat`.
 *
 * Chat panes rest on things the CLI does not promise us:
 *
 *   --permission-prompt-tool stdio   undocumented (absent from `claude --help`
 *                                    as of 2.1.220) and the whole approval card
 *                                    depends on it
 *   can_use_tool / control_response  request and response shapes
 *   updatedPermissions               what makes "always allow" stick
 *   stream_event deltas              text and thinking arriving incrementally
 *
 * Any of those can change without breaking a build or a unit test, because the
 * fixtures are recordings. This drives the real binary and fails loudly.
 *
 * Costs one cheap haiku turn. Denies the tool it is offered, so it writes
 * nothing outside its temp directory.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeNormalizer, claudeChatArgs } from '../src/main/claude-chat'
import { emptyChatState, reduceChat, type ChatState } from '../src/shared/agent-chat'

const TIMEOUT_MS = 120_000

interface Findings {
  sawSession: boolean
  sawStreamingText: boolean
  sawThinking: boolean
  sawToolStart: boolean
  sawApproval: boolean
  approvalHadSuggestion: boolean
  sawTurnEnd: boolean
  controlErrors: string[]
}

async function probe(): Promise<Findings> {
  const dir = mkdtempSync(join(tmpdir(), 'chewo-chat-canary-'))
  const found: Findings = {
    sawSession: false,
    sawStreamingText: false,
    sawThinking: false,
    sawToolStart: false,
    sawApproval: false,
    approvalHadSuggestion: false,
    sawTurnEnd: false,
    controlErrors: []
  }

  const args = claudeChatArgs({ model: 'haiku' })
  const proc = spawn('/bin/zsh', ['-ilc', 'claude "$@"', 'chewo', ...args], { cwd: dir })

  const normalize = createClaudeNormalizer()
  let state: ChatState = emptyChatState()
  let buffer = ''
  // Text arriving in more than one piece is what proves deltas still stream
  const textChunks = new Map<string, number>()

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      proc.kill()
      resolve()
    }
    const timer = setTimeout(finish, TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let raw: Record<string, unknown>
        try {
          raw = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }

        if (raw.type === 'control_response') {
          const response = raw.response as { subtype?: string; error?: unknown } | undefined
          if (response?.subtype === 'error')
            found.controlErrors.push(JSON.stringify(response).slice(0, 200))
        }

        for (const event of normalize(raw)) {
          state = reduceChat(state, event)
          if (event.type === 'session') found.sawSession = true
          if (event.type === 'tool_start') found.sawToolStart = true
          if (event.type === 'block_delta')
            textChunks.set(event.blockId, (textChunks.get(event.blockId) ?? 0) + 1)

          if (event.type === 'tool_approval') {
            found.sawApproval = true
            found.approvalHadSuggestion = event.suggestions.length > 0
            // Deny — the canary must not write anything, and a denial still
            // exercises the response path
            proc.stdin.write(
              JSON.stringify({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: event.requestId,
                  response: { behavior: 'deny', message: 'canary' }
                }
              }) + '\n'
            )
          }

          if (event.type === 'turn_end') {
            found.sawTurnEnd = true
            clearTimeout(timer)
            finish()
          }
        }
      }
    })

    proc.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.on('close', () => {
      clearTimeout(timer)
      resolve()
    })

    proc.stdin.write(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'Write a file canary.txt containing the word ping. Explain in one sentence what you did.'
        }
      }) + '\n'
    )
  })

  found.sawThinking = state.items.some((i) => i.kind === 'thinking' && i.text.length > 0)
  found.sawStreamingText = [...textChunks.values()].some((n) => n > 1)
  rmSync(dir, { recursive: true, force: true })
  return found
}

const CHECKS: Array<{ key: keyof Findings; label: string; fatal: boolean }> = [
  { key: 'sawSession', label: 'system/init → session id + slash commands', fatal: true },
  { key: 'sawToolStart', label: 'tool_use blocks → tool chips', fatal: true },
  { key: 'sawApproval', label: '--permission-prompt-tool stdio → can_use_tool (UNDOCUMENTED)', fatal: true },
  { key: 'sawTurnEnd', label: 'result → turn end', fatal: true },
  { key: 'sawStreamingText', label: '--include-partial-messages → incremental deltas', fatal: false },
  { key: 'sawThinking', label: 'thinking blocks captured', fatal: false },
  { key: 'approvalHadSuggestion', label: 'permission_suggestions → "always allow" button', fatal: false }
]

const found = await probe()

let failed = false
for (const { key, label, fatal } of CHECKS) {
  const ok = Boolean(found[key])
  if (!ok && fatal) failed = true
  console.log(`${ok ? '  ok  ' : fatal ? ' FAIL ' : ' warn '} ${label}`)
}

if (found.controlErrors.length) {
  failed = true
  console.log('\ncontrol_response errors (the CLI rejected something we sent):')
  for (const err of found.controlErrors) console.log(`  ${err}`)
}

if (failed) {
  console.log('\nChat panes are broken against this CLI version. The terminal view still works —')
  console.log('that is the point of keeping it. Re-check the flags in src/main/claude-chat.ts.')
  process.exit(1)
}
console.log('\nchat protocol intact')
