import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAgentJson } from './agent-runner'
import { agentFor } from './settings'

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

/** Short enough that a hung CLI doesn't strand a click, long enough for a cold start. */
const TIMEOUT_MS = 25_000

/** Diffs are unbounded; the model only needs enough to see the shape of a change. */
const MAX_DIFF_CHARS = 8_000

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

async function ask<T>(
  label: string,
  prompt: string,
  schema: string,
  read: (value: Record<string, unknown>) => T | null
): Promise<T | null> {
  try {
    const raw = await runAgentJson({
      choice: agentFor('gitText'),
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
    diffStat.slice(0, 4_000),
    '',
    '--- diff (truncated) ---',
    diffText.slice(0, MAX_DIFF_CHARS)
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
    diffStat.slice(0, 4_000)
  ].join('\n')
}
