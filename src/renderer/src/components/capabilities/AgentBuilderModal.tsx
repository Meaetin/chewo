import { useMemo, useState } from 'react'
import { Sparkles, TriangleAlert } from 'lucide-react'
import { ModalShell } from '../ModalShell'
import { Select, type SelectOption } from '../Select'
import { Button } from '../ui'
import { sanitizeAgentName, serializeAgent, type AgentDraft } from '../../../../shared/capabilities/agent-file'
import { approxTokens, type SkillOption } from '../../../../shared/capabilities/agent-draft'
import type { CopyDestination, CopyResult } from '../../../../shared/capabilities/types'

/**
 * Describe an agent, read what was drafted, change anything, then save.
 *
 * The two phases are the whole point: **nothing is written until the review
 * screen is agreed**. An agent definition is a system prompt and a tool
 * policy, and both are things a person should read before they start running
 * on their behalf.
 */

interface AgentBuilderModalProps {
  /** Every skill that could be attached, flattened from the inventory */
  skills: SkillOption[]
  /** Existing agents, so the draft doesn't collide with a live router */
  existing: Array<{ name: string; description: string }>
  destinations: CopyDestination[]
  /**
   * Seeded when editing, in which case the describe phase is skipped.
   *
   * `source` is the file's original text, and it is not optional: the save
   * preserves every frontmatter key this app does not model by re-reading it,
   * so a preview rendered without it shows a file that is **not** the one
   * about to be written — missing exactly the keys the subtitle promises to
   * keep.
   */
  edit?: { draft: AgentDraft; dest: CopyDestination; source: string }
  onClose: () => void
  onSaved: (result: CopyResult) => void
}

const MODELS: SelectOption<string>[] = [
  { value: '', label: 'Inherit', detail: 'Runs on whatever the session is on' },
  { value: 'opus', label: 'Opus', detail: 'Architecture, security, review' },
  { value: 'sonnet', label: 'Sonnet', detail: 'Docs, tests, debugging' },
  { value: 'haiku', label: 'Haiku', detail: 'Fast mechanical work' },
  { value: 'fable', label: 'Fable', detail: 'Long autonomous runs' }
]

const EFFORTS: SelectOption<string>[] = [
  { value: '', label: 'Inherit' },
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ value: e, label: e }))
]

const destKey = (d: CopyDestination): string => `${d.kind}:${d.tool}:${d.path ?? ''}`

/** `Read, Grep` ⇄ `['Read','Grep']` — the field is a text box, not a picker. */
const listText = (items: string[]): string => items.join(', ')
const parseListText = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export function AgentBuilderModal({
  skills,
  existing,
  destinations,
  edit,
  onClose,
  onSaved
}: AgentBuilderModalProps): React.JSX.Element {
  const [request, setRequest] = useState('')
  const [draft, setDraft] = useState<AgentDraft | null>(edit?.draft ?? null)
  const [dest, setDest] = useState<string>(
    edit ? destKey(edit.dest) : destKey(destinations[0] ?? { kind: 'global', tool: 'claude', label: '' })
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = (over: Partial<AgentDraft>): void =>
    setDraft((d) => (d ? { ...d, ...over } : d))

  const byName = useMemo(() => new Map(skills.map((s) => [s.name, s])), [skills])

  /**
   * What preloading the currently-ticked skills costs per invocation. Shown as
   * a running total because the per-skill figures are small enough to feel
   * free one at a time and are not, in aggregate: figma's twelve come to about
   * fifty thousand tokens.
   */
  const preloadTokens = (draft?.skills ?? [])
    .filter((s) => s.preload)
    .reduce((n, s) => n + approxTokens(byName.get(s.name)?.bytes ?? 0), 0)

  /**
   * Chosen skills an agent could not actually reach, each with the reason in
   * the user's terms. A disabled plugin is the common case and reads nothing
   * like "not installed" — its files are right there.
   */
  const unreachable = (draft?.skills ?? [])
    .filter((s) => !s.installed)
    .map((s) => {
      const info = byName.get(s.name)
      return { what: `${s.name} — ${info?.unavailableReason ?? 'it is not installed'}` }
    })

  const generate = (): void => {
    if (!request.trim()) return
    setBusy(true)
    setError(null)
    window.api
      .draftAgent({ request: request.trim(), skills, existing })
      .then((result) => {
        if (result.ok) setDraft(result.draft)
        else setError(result.error)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const save = (overwrite = false): void => {
    const target = destinations.find((d) => destKey(d) === dest)
    if (!draft || !target) return
    setBusy(true)
    setError(null)
    window.api
      .writeAgent({ draft, dest: target, overwrite })
      .then((result) => {
        if (result.status === 'copied') {
          onSaved(result)
          return
        }
        if (result.status === 'exists')
          setError(`An agent called ${sanitizeAgentName(draft.name)} already exists there.`)
        else setError(result.error ?? 'Could not write the agent.')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  // ---------- describe ----------

  if (!draft) {
    return (
      <ModalShell
        title="New agent"
        subtitle="Describe what it should do and when it should be used."
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <Button intent="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={generate} disabled={busy || !request.trim()}>
              {busy ? 'Drafting…' : 'Draft agent'}
            </Button>
          </>
        }
      >
        <div className="agent-builder">
          <label className="agent-field">
            <span className="agent-field__label">What should this agent do?</span>
            <textarea
              className="agent-field__input agent-field__input--tall"
              value={request}
              autoFocus
              placeholder="Reviews pull requests for security problems before they merge. Reads code but never changes it."
              onChange={(e) => setRequest(e.target.value)}
            />
            <span className="agent-field__hint">
              Say when it should be reached for, not just what it knows — that is what decides
              whether work gets handed to it.
            </span>
          </label>
          {busy && (
            <p className="agent-builder__waiting">
              Writing the system prompt and choosing skills. This usually takes under a minute.
            </p>
          )}
          {error && <div className="transcript-error">{error}</div>}
        </div>
      </ModalShell>
    )
  }

  // ---------- review ----------

  const fileName = `${sanitizeAgentName(draft.name) || '…'}.md`

  return (
    <ModalShell
      title={edit ? 'Edit agent' : 'Review agent'}
      subtitle={
        edit ? 'Saving rewrites the file. Nothing it does not show is lost.' : 'Nothing is written yet.'
      }
      size="xwide"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button intent="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => save(Boolean(edit))} disabled={busy || !draft.name.trim()}>
            {busy ? 'Saving…' : `Save ${fileName}`}
          </Button>
        </>
      }
    >
      <div className="agent-builder">
        <div className="agent-field-row">
          <label className="agent-field">
            <span className="agent-field__label">Name</span>
            <input
              className="agent-field__input"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <span className="agent-field__hint">Saved as {fileName}; invoked as @{sanitizeAgentName(draft.name)}</span>
          </label>
          <label className="agent-field agent-field--narrow">
            <span className="agent-field__label">Model</span>
            <Select
              value={draft.model ?? ''}
              options={MODELS}
              onChange={(v) => patch({ model: v || undefined })}
            />
          </label>
          <label className="agent-field agent-field--narrow">
            <span className="agent-field__label">Effort</span>
            <Select
              value={draft.effort ?? ''}
              options={EFFORTS}
              onChange={(v) => patch({ effort: v || undefined })}
            />
          </label>
        </div>

        <label className="agent-field">
          <span className="agent-field__label">When to use it</span>
          <textarea
            className="agent-field__input"
            rows={3}
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
          <span className="agent-field__hint">
            The router — the only part of this file the main agent reads when deciding whether to
            hand work over.
          </span>
        </label>

        <div className="agent-field-row">
          <label className="agent-field">
            <span className="agent-field__label">Tools it may use</span>
            <input
              className="agent-field__input"
              value={listText(draft.tools)}
              placeholder="every tool"
              onChange={(e) => patch({ tools: parseListText(e.target.value) })}
            />
            <span className="agent-field__hint">Empty grants every tool, not none.</span>
          </label>
          <label className="agent-field">
            <span className="agent-field__label">Tools it may not</span>
            <input
              className="agent-field__input"
              value={listText(draft.disallowedTools)}
              placeholder="none"
              onChange={(e) => patch({ disallowedTools: parseListText(e.target.value) })}
            />
            <span className="agent-field__hint">e.g. Write, Edit for a read-only agent.</span>
          </label>
        </div>

        <label className="agent-field">
          <span className="agent-field__label">System prompt</span>
          <textarea
            className="agent-field__input agent-field__input--prompt"
            value={draft.systemPrompt}
            onChange={(e) => patch({ systemPrompt: e.target.value })}
          />
          <span className="agent-field__hint">
            This is the whole of what the agent is told — it inherits nothing else.
          </span>
        </label>

        {draft.skills.length > 0 && (
          <section className="agent-skills">
            <div className="agent-skills__head">
              <span className="agent-field__label">Skills</span>
              {preloadTokens > 0 && (
                <span className="agent-skills__budget">
                  ~{preloadTokens.toLocaleString()} tokens preloaded every run
                </span>
              )}
            </div>
            <p className="agent-field__hint">
              A skill is discoverable as soon as it is installed — the agent reads its one-line
              description and opens it when needed. <strong>Preload</strong> loads the whole body at
              startup instead, on every single run. Worth it only when the agent uses it nearly
              always, or when you need a guarantee rather than the model&rsquo;s judgement.
            </p>
            {draft.skills.map((skill, i) => {
              const info = byName.get(skill.name)
              const cost = approxTokens(info?.bytes ?? 0)
              return (
                <div key={skill.name} className="agent-skill">
                  <div className="agent-skill__main">
                    <div className="agent-skill__line">
                      <span className="capability-name">{skill.name}</span>
                      <span className="capability-detail">{info?.description}</span>
                    </div>
                    <span className="capability-subdetail">
                      {info?.origin}
                      {/* "not installed" is wrong for the common case: a
                          disabled plugin's skills are on disk and simply reach
                          nobody, so the row says which it is. */}
                      {!skill.installed && ` · ${info?.unavailableReason ?? 'not installed'}`}
                      {cost > 0 && ` · ~${cost.toLocaleString()} tokens to preload`}
                    </span>
                    {skill.reason && <p className="agent-skill__reason">{skill.reason}</p>}
                  </div>
                  <label className="agent-skill__toggle">
                    <input
                      type="checkbox"
                      checked={skill.preload}
                      onChange={(e) => {
                        const next = [...draft.skills]
                        next[i] = { ...skill, preload: e.target.checked }
                        patch({ skills: next })
                      }}
                    />
                    Preload
                  </label>
                </div>
              )
            })}
            {unreachable.length > 0 && (
              <div className="agent-builder__notice">
                <TriangleAlert size={14} strokeWidth={1.75} />
                <span>
                  Saving records {unreachable.length === 1 ? 'this skill' : 'these skills'} in the
                  file, but the agent will not see{' '}
                  {unreachable.length === 1 ? 'it' : 'them'} until you fix that:{' '}
                  {unreachable.map((r) => r.what).join('; ')}.
                </span>
              </div>
            )}
          </section>
        )}

        <details className="agent-preview">
          <summary>
            <Sparkles size={13} strokeWidth={1.75} /> The file as it will be written
          </summary>
          <pre className="agent-preview__body">{serializeAgent(draft, edit?.source)}</pre>
        </details>

        <label className="agent-field">
          <span className="agent-field__label">Save to</span>
          <Select
            value={dest}
            options={destinations.map((d) => ({ value: destKey(d), label: d.label }))}
            onChange={setDest}
          />
          <span className="agent-field__hint">
            Sessions already running will not see it until they restart.
          </span>
        </label>

        {error && <div className="transcript-error">{error}</div>}
      </div>
    </ModalShell>
  )
}
