import { GENERAL_SCOPE, TODO_STATUSES, type TodoStatus } from '../shared/todos'

/**
 * Prompt + output adapter for the voice-command interpreter (SPEC-TODOS §6).
 * Electron-free so tests can cover it: the `--output-format json` envelope
 * is the same internal-schema risk as session JSONL (KNOWN-ISSUES #1), so
 * all parsing of it is isolated here.
 */

export interface TodoCommand {
  action: 'add' | 'move' | 'edit' | 'delete' | 'none'
  scope: string
  cardId?: string | null
  title?: string | null
  text?: string | null
  to?: string | null
}

// Enforced by --json-schema: an ordered list of commands, so one utterance
// can do several things ("delete A and B", "add X and mark Y done").
export const COMMAND_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'move', 'edit', 'delete', 'none'] },
          scope: { type: 'string' },
          cardId: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          text: { type: ['string', 'null'] },
          to: { type: ['string', 'null'] }
        },
        required: ['action', 'scope']
      }
    }
  },
  required: ['commands']
})

export interface ScopeSnapshot {
  scope: string
  name: string
  cards: Array<{ id: string; title: string; column: TodoStatus }>
}

export const buildPrompt = (transcript: string, scopes: ScopeSnapshot[]): string =>
  `You interpret a dictated command for a kanban todo app and return only the structured commands.

Boards ("scopes") and their current cards:
${JSON.stringify({ scopes })}

Utterance (may begin with the wake word "che-wo" — ignore it): ${JSON.stringify(transcript)}

Rules: return the commands to perform, in utterance order — usually one, several when the utterance asks for several things ("delete A and B" → two delete commands; "the rest of the todos" → one command per matching card). "add" needs scope + title (concise imperative title; put extra detail in "text"). "move" needs cardId + to (one of ${JSON.stringify(TODO_STATUSES)}; fuzzy-match the card by title — dictation garbles words). "edit" needs cardId plus the new title and/or text. "delete" needs cardId. Use the scope whose project name the utterance mentions (fuzzy-match); otherwise scope "${GENERAL_SCOPE}". If intent is unclear or nothing matches, return exactly one command with action "none" and the reason in "text" — never mix "none" with real commands.`

/**
 * Reads the command list out of the agent's schema-constrained answer. The
 * per-agent envelope (claude's `structured_output`, codex's final message) is
 * already unwrapped by `agent-runner`; what arrives here is the object the
 * schema describes. A bare single command is tolerated in case the model
 * sidesteps the wrapper.
 */
export function parseInterpreterOutput(structured: unknown): TodoCommand[] {
  if (!structured || typeof structured !== 'object')
    throw new Error('Interpreter returned unparseable output.')
  const commands = (structured as { commands?: unknown }).commands
  if (Array.isArray(commands)) return commands as TodoCommand[]
  if ('action' in structured) return [structured as TodoCommand]
  throw new Error(`Interpreter gave no command: ${JSON.stringify(structured).slice(0, 120)}`)
}
