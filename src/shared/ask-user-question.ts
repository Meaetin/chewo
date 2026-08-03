/**
 * `AskUserQuestion` — the tool whose permission card *is* its UI.
 *
 * The CLI flags its `can_use_tool` request with `requires_user_interaction`,
 * which the SDK types define as "one-tap Approve/Deny must not be offered: the
 * tool's approval card IS the user-interaction surface — the user responds on
 * the card itself". Rendering the generic Allow/Deny card for it therefore asks
 * a question nobody wanted answered *and* drops the one that was: allowing it
 * runs the tool with no answers, and the model is told "The user did not answer
 * the questions."
 *
 * The answers ride back inside `updatedInput`. Verified against CLI 2.1.220 on
 * 2026-08-03: `{...input, answers: { '<question text>': '<answer>' }}` yields
 * `Your questions have been answered: "…"="…"` to the model, while an empty or
 * differently-keyed map yields "did not answer". Two details are load-bearing
 * and neither is guessable — the map is keyed by the **question text**, not the
 * `header` the card displays, and a multi-select answer is **one
 * comma-separated string**, not an array.
 *
 * Renderer-safe: no node imports in this file.
 */

export interface AskOption {
  label: string
  description?: string
  /** Mockup or snippet the CLI wants shown while the option is focused */
  preview?: string
}

export interface AskQuestion {
  question: string
  /** Short chip label (≤12 chars) — display only, never an answer key */
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

function toOption(value: unknown): AskOption | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.label !== 'string' || !o.label) return null
  return {
    label: o.label,
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(typeof o.preview === 'string' ? { preview: o.preview } : {})
  }
}

/**
 * The tool's arguments → questions to draw, or `null` for anything that is not
 * a question set. Returning `null` is what lets the card fall back to the
 * ordinary Allow/Deny prompt rather than rendering an empty dialog: a future
 * tool could set `requires_user_interaction` with a shape we have never seen.
 */
export function parseAskQuestions(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== 'object') return null
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw) || raw.length === 0) return null

  const questions: AskQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const q = item as Record<string, unknown>
    if (typeof q.question !== 'string' || !q.question) return null
    const options = Array.isArray(q.options)
      ? q.options.map(toOption).filter((o): o is AskOption => o !== null)
      : []
    questions.push({
      question: q.question,
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options
    })
  }
  return questions
}

/**
 * Selections → the `answers` map the tool reads, keyed by question text.
 * Questions the user left blank are omitted rather than sent empty, so a
 * partial answer is never reported as an answered one.
 */
export function composeAnswers(
  questions: AskQuestion[],
  picks: string[][]
): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((q, i) => {
    const chosen = (picks[i] ?? []).map((p) => p.trim()).filter(Boolean)
    if (chosen.length) answers[q.question] = chosen.join(', ')
  })
  return answers
}
