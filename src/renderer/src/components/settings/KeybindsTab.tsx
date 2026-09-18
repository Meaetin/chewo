import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  accelFromEvent,
  FIXED_KEYS,
  findConflict,
  formatKeybind,
  KEYBINDS,
  keybindDef,
  type KeybindId,
  type KeybindMap
} from '../../../../shared/keybinds'
import { IconButton } from '../ui'
import { setKeybindRecording } from '../../keybinds'

/**
 * Every shortcut the app owns, rebindable ones first and the fixed keys under
 * them. The fixed list is not padding: a pane that shows only what you can
 * change answers half the question you came in with.
 *
 * Recording swallows the keypress in the capture phase, so arming a row and
 * pressing ⌘, records the comma rather than closing the settings window you
 * are standing in.
 */

interface KeybindsTabProps {
  keybinds: KeybindMap
  onChange: (map: KeybindMap) => void
}

export function KeybindsTab({ keybinds, onChange }: KeybindsTabProps): React.JSX.Element {
  const [recording, setRecording] = useState<KeybindId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Other capture-phase listeners (the chat find bar) are registered before
    // this one and would act on the chord as well as feed it here
    setKeybindRecording(recording !== null)
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        setError(null)
        return
      }
      const accel = accelFromEvent(e)
      // A bare key or a lone modifier is not a chord — keep listening rather
      // than binding something that would swallow typing
      if (!accel) return
      const clash = findConflict(keybinds, recording, accel)
      if (clash) {
        setError(`${formatKeybind(accel)} already runs “${keybindDef(clash).label}”.`)
        return
      }
      onChange({ ...keybinds, [recording]: accel })
      setRecording(null)
      setError(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      setKeybindRecording(false)
    }
  }, [recording, keybinds, onChange])

  const groups = [...new Set(KEYBINDS.map((k) => k.group))]

  return (
    <div className="settings-keybinds">
      {groups.map((group) => (
        <section key={group} className="settings-keybind-group">
          <h3 className="settings-keybind-group-title">{group}</h3>
          {KEYBINDS.filter((k) => k.group === group).map((def) => {
            const armed = recording === def.id
            const changed = keybinds[def.id] !== def.default
            return (
              <div key={def.id} className="settings-keybind-row">
                <div className="settings-keybind-meta">
                  <div className="settings-keybind-label">{def.label}</div>
                  <div className="settings-keybind-hint">{def.detail}</div>
                  {def.scope === 'system' && (
                    <div className="settings-keybind-note">
                      Registered with macOS, so it works while another app is in front — and fails
                      to register if that app already holds it.
                    </div>
                  )}
                  {armed && error && <div className="settings-keybind-error">{error}</div>}
                </div>
                <div className="settings-keybind-controls">
                  <button
                    type="button"
                    className={`settings-keybind-chord${
                      armed ? ' settings-keybind-chord--armed' : ''
                    }`}
                    aria-label={`Change the shortcut for ${def.label}`}
                    onClick={() => {
                      setError(null)
                      setRecording(armed ? null : def.id)
                    }}
                  >
                    {armed ? 'Press keys…' : formatKeybind(keybinds[def.id])}
                  </button>
                  <IconButton
                    label={`Reset to ${formatKeybind(def.default)}`}
                    dense
                    size={14}
                    disabled={!changed}
                    onClick={() => {
                      setError(null)
                      setRecording(null)
                      onChange({ ...keybinds, [def.id]: def.default })
                    }}
                  >
                    <RotateCcw size={14} strokeWidth={1.75} />
                  </IconButton>
                </div>
              </div>
            )
          })}
        </section>
      ))}

      <section className="settings-keybind-group">
        <h3 className="settings-keybind-group-title">Fixed</h3>
        <p className="settings-keybind-blurb">
          These are how the interface works rather than shortcuts Chewo picked, so they stay put.
        </p>
        {FIXED_KEYS.map((group) => (
          <div key={group.group} className="settings-keybind-fixed-group">
            <div className="settings-keybind-fixed-title">{group.group}</div>
            {group.rows.map((row) => (
              <div key={`${group.group}-${row.keys}-${row.label}`} className="settings-keybind-fixed-row">
                <span className="settings-keybind-fixed-keys">{row.keys}</span>
                <span className="settings-keybind-fixed-label">{row.label}</span>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  )
}
