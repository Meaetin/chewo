import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAgentJson } from './agent-runner'
import { agentFor } from './settings'
import type { AgentChoice } from '../shared/agents'

/**
 * The prose git needs and nobody wants to write: a commit message for a diff,
 * a title and body for a PR. Both go through the agent-agnostic runner
 * (`runAgentJson`), so this file is the only place that knows a CLI is
 * involved — callers just ask for text.
 *
 * Branch names are **not** here: naming five words is a regex's job, and it
 * lives in `src/shared/branch-names.ts` so no session start pays for a CLI
 * spawn. What is left is the work a model is actually better at — reading a
 * diff and saying what it does.
 *
 * Both functions are **best effort**. A commit message that took eight seconds
 * and a CLI that is mid-update are both worse than a plain string, so each
 * falls back to a deterministic local value on any failure, timeout or
 * nonsense answer. Nothing in the git pipeline may block on an agent.
 */

/**
 * Short enough that a hung CLI doesn't strand a click, long enough that a
 * *working* one is never killed just before it answers.
 *
 * Measured 2026-08-09 against CLI 2.1.220 on an 8.6 KB prompt: the old 25s
 * budget was under the real latency of every model tried, so Ship's message
 * was the fallback essentially always — and silently, since a fallback reads
 * exactly like an answer. The CLI's own default model ran 25.4s in a repo and
 * 50.9s / 60.2s from the neutral cwd; sonnet 33.8s; haiku 12–32s, wildly
 * variable. Only `opus` at `medium` effort was both fast and repeatable
 * (13.8 / 17.7 / 13.9s), which is what `FAST_TEXT` pins below.
 */
const TIMEOUT_MS = 90_000

/**
 * Ship blocks on this call, so an omitted model does **not** mean "let the CLI
 * decide" here the way it does for the other headless tasks — the CLI's own
 * default is a full-effort frontier run, measured at up to 60s of a click. An
 * explicit choice in Settings → Agents still wins; this only fills a blank.
 * Codex is left alone: its catalog is discovered at runtime, so there is no id
 * that can be hardcoded honestly.
 */
const FAST_TEXT: AgentChoice = { agent: 'claude', model: 'opus', effort: 'medium' }

/**
 * Diffs are unbounded, so there has to be a cap — but it was 8,000, which is
 * five lines per file on a twenty-file commit.
 *
 * Measured 2026-08-09 on this repo's largest commit (93 KB, 21 files) with
 * `budgetDiff` splitting the budget evenly: **latency does not grow with the
 * prompt**. 21.8s at 8 KB, 17.2s at 24 KB, 16.9s at 48 KB, 15.8s at 96 KB —
 * the wait is startup plus the message being written, not the diff being read,
 * so there is no speed argument for starving the model. Quality does move: at
 * 8,000 it saw only the first of the commit's two changes and wrote a subject
 * that omitted the other half; from 24,000 up it named both. 96,000 was
 * marginally sharper still and is left on the table deliberately — this runs
 * once per Ship click, and 48,000 is about 12k tokens, which buys the whole
 * story of any commit a person actually reviews while still bounding a
 * pathological diff (a vendored directory, a regenerated lockfile).
 */
const MAX_DIFF_CHARS = 48_000

/**
 * The diffstat is the cheapest signal there is — it names every file in the
 * change in a line each — so it is capped far above what it needs (the 21-file
 * commit above stats to 1.4 KB) rather than at the diff's budget.
 */
const MAX_STAT_CHARS = 12_000

/**
 * These spawns are pinned **outside** the user's repos, like every other
 * headless feature (`todo-voice` pins to `~/.chewo/todos`, notes to the notes
 * root). A CLI writes a session file keyed on its cwd, and the sidebar assigns
 * sessions to a project by that path — so running one of these in the repo it
 * describes files a "Name a git branch after this task" session in that
 * project's list, once per call. Nothing here reads the tree anyway: the diff
 * and the task text are both in the prompt.
 */
function neutralCwd(): string {
  const dir = join(homedir(), '.chewo', 'git-text')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The configured agent, with the speed pin filling in anything left blank. */
function textChoice(): AgentChoice {
  const choice = agentFor('gitText')
  if (choice.agent !== FAST_TEXT.agent) return choice
  return {
    ...choice,
    model: choice.model || FAST_TEXT.model,
    effort: choice.effort || FAST_TEXT.effort
  }
}

async function ask<T>(
  label: string,
  prompt: string,
  schema: string,
  read: (value: Record<string, unknown>) => T | null
): Promise<T | null> {
  try {
    const raw = await runAgentJson({
      choice: textChoice(),
      cwd: neutralCwd(),
      prompt,
      schema,
      timeoutMs: TIMEOUT_MS,
      label
    })
    if (!raw || typeof raw !== 'object') return null
    return read(raw as Record<string, unknown>)
  } catch {
    // Deliberately swallowed: the caller has a local fallback and the user is
    // waiting on a git operation, not on prose.
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Share the diff budget across the files in it, instead of taking the first N
 * characters of the whole thing.
 *
 * `git diff` emits files in path order, so a plain `slice` is a lottery held on
 * filenames: whatever sorts first gets the whole budget and everything after it
 * is invisible. Found 2026-08-09 on a four-file change here — `AGENTS.md` sorted
 * first and consumed all 8,000 characters on its own, so the model wrote a
 * confident commit subject about code it had never seen. An appended hunk makes
 * it worse than it sounds: the *context* lines around the change are also that
 * file's prose, so the model reads paragraphs describing work from other
 * commits and summarises those.
 *
 * Each file gets an equal share; anything smaller than its share hands the
 * remainder back, and the leftovers are redistributed to the files that are
 * still over. Truncation is announced per file rather than silently — a diff
 * that just stops reads as a complete change, which is the whole bug.
 */
export function budgetDiff(diff: string, max: number): string {
  if (diff.length <= max) return diff
  // The delimiter starts a line and belongs to the section it opens
  const parts = diff.split(/\n(?=diff --git )/)
  if (parts.length < 2) return `${diff.slice(0, max)}\n… diff truncated`

  const shares = new Array<number>(parts.length).fill(0)
  let pool = max
  let open = parts.map((_, i) => i)
  while (open.length > 0) {
    const share = Math.floor(pool / open.length)
    if (share <= 0) break
    const fits = open.filter((i) => parts[i].length <= share)
    if (fits.length === 0) {
      for (const i of open) shares[i] = share
      break
    }
    for (const i of fits) {
      shares[i] = parts[i].length
      pool -= parts[i].length
    }
    open = open.filter((i) => parts[i].length > share)
  }

  return parts
    .map((part, i) => {
      if (part.length <= shares[i]) return part
      // The notice is part of what this file spends, not an extra — added on
      // top it puts the prompt over the cap once per truncated file
      const dropped = part.slice(shares[i]).split('\n').length
      const notice = `… ${dropped} more lines of this file's diff not shown`
      const kept = part.slice(0, Math.max(0, shares[i] - notice.length - 1))
      // Cut on a line boundary — half a hunk header reads as corruption
      const end = kept.lastIndexOf('\n')
      return `${end > 0 ? kept.slice(0, end + 1) : kept}${notice}`
    })
    .join('\n')
}

/** A line that carries its own newline: list item, quote, heading, fence, indented code. */
const STRUCTURAL = /^(\s{4,}|\t|[-*+]\s|\d+[.)]\s|>|#{1,6}\s|```)/

/**
 * Undo hard wrapping, keeping the paragraph breaks.
 *
 * A 72-column commit body is a `git log` convention that predates editing one
 * in a text box: mid-sentence newlines mean the field soft-wraps text that is
 * already hard-wrapped, so it reads ragged, and changing a word leaves the
 * paragraph re-flowed by hand or not at all. Blank lines are real structure
 * and survive; so does anything a newline is load-bearing for (bullets, code,
 * quotes), which is why blocks are inspected rather than blindly joined.
 *
 * The prompt asks for unwrapped prose too — this is the belt to that braces,
 * because "wrapped at 72 columns" is what a model has seen in ten million
 * commits and it will sometimes do it whatever it was told.
 */
export function unwrapBody(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trimEnd())
      if (lines.some((l) => STRUCTURAL.test(l))) return lines.join('\n')
      return lines.map((l) => l.trim()).filter(Boolean).join(' ')
    })
    .filter(Boolean)
    .join('\n\n')
}

// ---------- commit messages ----------

export interface CommitMessage {
  subject: string
  body: string
}

const COMMIT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    subject: {
      type: 'string',
      description: 'Conventional-commit subject line, max 72 chars, imperative mood'
    },
    body: {
      type: ['string', 'null'],
      description:
        'Optional body explaining why, as unwrapped paragraphs separated by blank lines. Empty when the subject says it all.'
    }
  },
  required: ['subject']
})

/** `feat: …`-style subject, or a plain count when the agent can't be reached. */
export async function suggestCommitMessage(
  diffStat: string,
  diffText: string,
  fileCount: number
): Promise<CommitMessage> {
  const fallback: CommitMessage = {
    subject: `chore: update ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
    body: ''
  }
  const answer = await ask('Commit message', commitPrompt(diffStat, diffText), COMMIT_SCHEMA, (o) => {
    const subject = str(o.subject)
    return subject
      ? { subject: subject.split('\n')[0].slice(0, 72), body: unwrapBody(str(o.body)) }
      : null
  })
  return answer ?? fallback
}

function commitPrompt(diffStat: string, diffText: string): string {
  return [
    'Write a commit message for this staged change. Reply only through the schema.',
    '',
    'Subject: conventional commits (feat/fix/refactor/chore/docs/test/perf),',
    'imperative mood, max 72 characters, no trailing period.',
    'Body: only if the subject leaves something worth saying — say why, not what.',
    'Write it as whole paragraphs separated by blank lines. Do not hard-wrap',
    'lines at 72 columns or any other width — it is edited in a text box, not vi.',
    'Do not mention being an AI, and do not add a trailer or signature.',
    '',
    '--- diffstat ---',
    diffStat.slice(0, MAX_STAT_CHARS),
    '',
    '--- diff (long files are truncated; every changed file is represented) ---',
    budgetDiff(diffText, MAX_DIFF_CHARS)
  ].join('\n')
}

// ---------- pull requests ----------

export interface PrText {
  title: string
  body: string
}

const PR_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    title: { type: 'string', description: 'PR title, max 72 chars' },
    body: { type: ['string', 'null'], description: 'PR description in markdown' }
  },
  required: ['title']
})

/** Title and body for the PR, from the commits it carries. */
export async function suggestPrText(
  branch: string,
  commits: string[],
  diffStat: string
): Promise<PrText> {
  // One commit already has a human-readable subject — a good default title
  const fallback: PrText = {
    title: commits.length === 1 ? stripHash(commits[0]) : `${branch}: ${commits.length} commits`,
    body: commits.length ? commits.map((c) => `- ${stripHash(c)}`).join('\n') : ''
  }
  const answer = await ask('PR text', prPrompt(commits, diffStat), PR_SCHEMA, (o) => {
    const title = str(o.title)
    return title ? { title: title.split('\n')[0].slice(0, 72), body: str(o.body) } : null
  })
  return answer ?? fallback
}

/** `a1b2c3d subject` → `subject` (git log --oneline) */
const stripHash = (line: string): string => line.replace(/^[0-9a-f]{7,40}\s+/i, '')

function prPrompt(commits: string[], diffStat: string): string {
  return [
    'Write a pull request title and description for this branch.',
    'Reply only through the schema.',
    '',
    'Title: max 72 characters, imperative, no conventional-commit prefix needed.',
    'Body: markdown. Lead with one paragraph on what changed and why, then a',
    'short bullet list if there is more than one distinct change. No headings',
    'unless the change is genuinely large. Do not mention being an AI, and do',
    'not add a trailer or signature.',
    '',
    '--- commits ---',
    commits.slice(0, 100).join('\n'),
    '',
    '--- diffstat ---',
    diffStat.slice(0, MAX_STAT_CHARS)
  ].join('\n')
}
