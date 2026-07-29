import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, KeyRound, Trash2, Upload } from 'lucide-react'
import {
  formatBytes,
  formatDuration,
  formatRate,
  MULTI_LANGUAGE,
  STT_TIERS,
  tierFor,
  type PendingRecovery,
  type SttModelInfo,
  type SttSettings
} from '../../../../shared/stt'
import { Button, Input } from '../ui'
import { Select, type SelectOption } from '../Select'

/**
 * The Deepgram key behind notes dictation and to-do voice commands, plus the
 * model and language they use.
 *
 * This is the one place a key is ever entered, and the only Chewo feature that
 * carries a credential at all — every other integration borrows a CLI the user
 * has already signed in to. The key is written straight to the main process
 * and encrypted through the Keychain; the renderer only ever learns whether
 * one exists.
 *
 * The model list is enumerated from Deepgram at runtime rather than hardcoded
 * (same rule as the agent model lists), cached in main for the session. Until
 * it arrives — or if there is no key — the picker shows only the model already
 * chosen, rather than naming one it cannot confirm.
 */

interface KeyNote {
  ok: boolean
  text: string
  /** Wall-clock time the check landed, so a repeat click visibly updates */
  at: string
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * "en-US" → "English (United States)". Deepgram returns raw BCP-47 tags per
 * model; `Intl` already knows how to name them, so nothing is hardcoded here
 * either. `multi` is Deepgram's own code for its multilingual mode.
 */
function languageName(tag: string): string {
  if (tag === 'multi') return 'Multilingual'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

interface VoiceTabProps {
  stt: SttSettings
  onChange: (s: SttSettings) => void
  /** Whether a key is stored — the app-wide gate on recording */
  hasKey: boolean
  /** Re-reads status in App so every dictation control ungreys at once */
  onKeyChange: () => Promise<void>
  pending: PendingRecovery[]
  onRecover: (id: string) => Promise<void>
  onDiscardRecording: (id: string) => Promise<void>
}

export function VoiceTab({
  stt,
  onChange,
  hasKey,
  onKeyChange,
  pending,
  onRecover,
  onDiscardRecording
}: VoiceTabProps): React.JSX.Element {
  const [models, setModels] = useState<SttModelInfo[] | null>(null)
  const [draftKey, setDraftKey] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  /** Non-null while an action is in flight; the string is what it is doing. */
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const busy = busyLabel !== null
  const [keyNote, setKeyNote] = useState<KeyNote | null>(null)
  const [legacy, setLegacy] = useState<{ dir: string; bytes: number } | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  // No key means no catalog to read. Main caches the result for the session,
  // so this is a network round trip only on the first open.
  useEffect(() => {
    if (!hasKey) {
      setModels(null)
      return
    }
    let live = true
    void window.api.sttModels().then((list) => {
      if (live) setModels(list)
    })
    return () => {
      live = false
    }
  }, [hasKey])

  useEffect(() => {
    void window.api.sttLegacyModels().then(setLegacy)
  }, [])

  const tier = tierFor(stt)

  const tierOptions: SelectOption<string>[] = STT_TIERS.map<SelectOption<string>>((t) => ({
    value: t.key,
    label: t.label,
    detail: `${formatRate(t.pricePerMin)} — ${t.detail}`
  }))
    // A model set outside these two (an older setting, or a hand-edited file)
    // still gets a row, so the picker never misrepresents what is in use.
    .concat(
      STT_TIERS.some((t) => t.model === stt.model)
        ? []
        : [{ value: 'other', label: stt.model, detail: 'Not one of the offered models' }]
    )

  const selectTier = (key: string): void => {
    const picked = STT_TIERS.find((t) => t.key === key)
    if (!picked) return
    onChange({
      ...stt,
      model: picked.model,
      // Multilingual *is* the language setting; leaving `multi` in place when
      // switching back to monolingual would keep billing at the higher rate.
      language:
        picked.key === 'multi'
          ? MULTI_LANGUAGE
          : stt.language === MULTI_LANGUAGE
            ? 'en'
            : stt.language
    })
  }

  /** Languages the chosen model actually supports, straight from Deepgram. */
  const modelLanguages =
    models?.find((m) => m.id === stt.model)?.languages.filter((l) => l !== MULTI_LANGUAGE) ?? []

  const languageOptions: SelectOption<string>[] = Array.from(
    new Set([...modelLanguages, stt.language].filter((l) => l && l !== MULTI_LANGUAGE))
  )
    .map((tag) => ({ value: tag, label: languageName(tag), detail: tag }))
    .sort((a, b) => a.label.localeCompare(b.label))

  /**
   * Every result is stamped with the time it landed. Checking twice in a row
   * otherwise re-renders the identical sentence, which reads as a button that
   * did nothing — the one thing a "Test connection" button must never do.
   */
  const note = (ok: boolean, text: string): KeyNote => ({
    ok,
    text,
    at: new Date().toLocaleTimeString()
  })

  const saveKey = useCallback(async () => {
    setBusyLabel('Saving and verifying with Deepgram…')
    setKeyNote(null)
    try {
      const stored = await window.api.sttSetKey(draftKey)
      if (stored) {
        setKeyNote(note(false, stored))
        return
      }
      const rejected = await window.api.sttTestKey()
      setKeyNote(rejected ? note(false, rejected) : note(true, 'Key saved and verified.'))
      setDraftKey('')
      setEditingKey(false)
      await onKeyChange()
    } catch (error) {
      // An IPC rejection with no catch leaves the button spinning forever and
      // says nothing — always land on a message.
      setKeyNote(note(false, `Could not store the key: ${message(error)}`))
    } finally {
      setBusyLabel(null)
    }
  }, [draftKey, onKeyChange])

  const testKey = useCallback(async () => {
    setBusyLabel('Checking with Deepgram…')
    setKeyNote(null)
    try {
      const rejected = await window.api.sttTestKey()
      setKeyNote(rejected ? note(false, rejected) : note(true, 'Deepgram is reachable.'))
    } catch (error) {
      setKeyNote(note(false, `Could not reach Deepgram: ${message(error)}`))
    } finally {
      setBusyLabel(null)
    }
  }, [])

  const removeKey = useCallback(async () => {
    setBusyLabel('Removing the key…')
    try {
      await window.api.sttClearKey()
      setKeyNote(null)
      setEditingKey(false)
      await onKeyChange()
    } catch (error) {
      setKeyNote(note(false, `Could not remove the key: ${message(error)}`))
    } finally {
      setBusyLabel(null)
    }
  }, [onKeyChange])

  const showField = !hasKey || editingKey

  return (
    <div className="settings-voice">
      <p className="settings-voice-callout">
        Dictation streams your audio to <strong>Deepgram</strong> to be transcribed — it is not
        processed on this Mac, and it needs a connection. Recording a meeting or online lesson sends
        the other participants&rsquo; voices too.
      </p>

      {/* ---- API key ---- */}
      <section className="settings-voice-section">
        <h3 className="settings-voice-heading">API key</h3>

        {showField ? (
          <div className="settings-voice-keyrow">
            <Input
              type="password"
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your Deepgram API key"
              aria-label="Deepgram API key"
              value={draftKey}
              onChange={(e) => setDraftKey(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draftKey.trim()) void saveKey()
              }}
            />
            <Button
              intent="primary"
              size="compact"
              disabled={busy || !draftKey.trim()}
              loading={busy}
              loadingText="Verifying…"
              onClick={() => void saveKey()}
            >
              Save key
            </Button>
            {editingKey && (
              <Button
                intent="secondary"
                size="compact"
                disabled={busy}
                onClick={() => {
                  setDraftKey('')
                  setEditingKey(false)
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <div className="settings-voice-keyrow">
            <span className="settings-voice-keystate">
              <KeyRound size={13} strokeWidth={1.75} aria-hidden="true" /> Key stored in the macOS
              Keychain
            </span>
            <Button
              intent="secondary"
              size="compact"
              disabled={busy}
              loading={busy}
              loadingText="Checking…"
              onClick={() => void testKey()}
            >
              Test connection
            </Button>
            <Button
              intent="secondary"
              size="compact"
              disabled={busy}
              onClick={() => setEditingKey(true)}
            >
              Replace
            </Button>
            <Button intent="danger" size="compact" disabled={busy} onClick={() => void removeKey()}>
              Remove
            </Button>
          </div>
        )}

        {(busy || keyNote) && (
          <p
            className={`settings-voice-note ${
              busy ? '' : keyNote?.ok ? 'settings-voice-note-ok' : 'settings-voice-note-bad'
            }`}
            role="status"
            aria-live="polite"
          >
            {busy ? (
              busyLabel
            ) : (
              <>
                {keyNote?.ok ? (
                  <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <AlertCircle size={12} strokeWidth={2} aria-hidden="true" />
                )}
                {keyNote?.text}
                <span className="settings-voice-note-time">{keyNote?.at}</span>
              </>
            )}
          </p>
        )}

        {!hasKey && (
          <p className="settings-voice-footnote">
            Create one at <code>console.deepgram.com</code> — new accounts currently start with
            $200 of free credit. Nova-3 runs $0.0048 a minute after that, so a two-hour lecture is
            about $0.58.
          </p>
        )}
      </section>

      {/* ---- Model + language ---- */}
      <section className="settings-voice-section">
        <h3 className="settings-voice-heading">Transcription</h3>

        <div className="settings-voice-field">
          <label className="settings-voice-field-label" htmlFor="stt-model">
            Model
          </label>
          <Select
            id="stt-model"
            value={tier.key}
            options={tierOptions}
            onChange={selectTier}
          />
        </div>

        {/* Multilingual picks its own languages, so there is nothing to set */}
        {tier.key === 'mono' && (
          <div className="settings-voice-field">
            <label className="settings-voice-field-label" htmlFor="stt-language">
              Language
            </label>
            <Select
              id="stt-language"
              searchable
              searchPlaceholder="Search languages…"
              value={stt.language}
              options={languageOptions}
              onChange={(language) => onChange({ ...stt, language })}
            />
            {hasKey && models === null && (
              <p className="settings-voice-footnote settings-voice-footnote-tight">
                Loading the language list from Deepgram…
              </p>
            )}
            {!hasKey && (
              <p className="settings-voice-footnote settings-voice-footnote-tight">
                The full list comes from Deepgram once a key is saved.
              </p>
            )}
          </div>
        )}

        <div className="settings-voice-field">
          <label className="settings-voice-field-label" htmlFor="stt-keyterms">
            Key terms
          </label>
          <Input
            id="stt-keyterms"
            placeholder="Nyquist, eigenvector, Dr Sandoval"
            value={stt.keyterms?.join(', ') ?? ''}
            onChange={(e) => {
              const keyterms = e.currentTarget.value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
              onChange({ ...stt, keyterms: keyterms.length ? keyterms : undefined })
            }}
          />
        </div>
        <p className="settings-voice-footnote">
          Key terms bias the model toward names and jargon a course keeps using. Nova-3 only —
          other models ignore them.
        </p>
      </section>

      {/* ---- Recoverable recordings ---- */}
      {pending.length > 0 && (
        <section className="settings-voice-section">
          <h3 className="settings-voice-heading">Unfinished recordings</h3>
          <p className="settings-voice-footnote settings-voice-footnote-tight">
            These lost their connection mid-recording, but the audio was saved. Recovering
            re-transcribes it and appends the result to its lesson.
          </p>

          <div className="settings-voice-list">
            {pending.map((rec) => (
              <div key={rec.id} className="settings-voice-row">
                <span className="settings-voice-meta">
                  <span className="settings-voice-label">
                    {new Date(rec.startedAt).toLocaleString()}
                  </span>
                  <span className="settings-voice-detail">
                    {formatDuration(rec.durationS)} · {formatBytes(rec.bytes)}
                    {rec.lessonPath ? ` · ${rec.lessonPath.split('/').pop()}` : ' · voice command'}
                  </span>
                </span>

                <span className="settings-voice-actions">
                  <Button
                    intent="primary"
                    size="compact"
                    disabled={working !== null || !hasKey}
                    loading={working === rec.id}
                    loadingText="Transcribing…"
                    leadingIcon={<Upload size={13} strokeWidth={1.75} />}
                    onClick={() => {
                      setWorking(rec.id)
                      void onRecover(rec.id).finally(() => setWorking(null))
                    }}
                  >
                    Recover
                  </Button>
                  <Button
                    intent="secondary"
                    size="compact"
                    disabled={working !== null}
                    leadingIcon={<Trash2 size={13} strokeWidth={1.75} />}
                    onClick={() => void onDiscardRecording(rec.id)}
                  >
                    Discard
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Reclaim the old Whisper cache ---- */}
      {legacy !== null && legacy.bytes > 0 && (
        <section className="settings-voice-section">
          <h3 className="settings-voice-heading">Storage</h3>
          <div className="settings-voice-row">
            <span className="settings-voice-meta">
              <span className="settings-voice-label">Old speech models</span>
              <span className="settings-voice-detail">
                Left in <code>{legacy.dir}</code> from when transcription ran on this Mac. Nothing
                uses them now.
              </span>
            </span>
            <Button
              intent="secondary"
              size="compact"
              leadingIcon={<Trash2 size={13} strokeWidth={1.75} />}
              onClick={() => {
                void window.api.sttRemoveLegacyModels().then(() => setLegacy({ ...legacy, bytes: 0 }))
              }}
            >
              Reclaim {formatBytes(legacy.bytes)}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}
