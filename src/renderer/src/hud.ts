import type { HudState } from '../../shared/todos'

/**
 * Voice HUD (SPEC-TODOS §6) — a tiny vanilla page in a frameless
 * always-on-top window. Main pushes partial HudState objects; defined
 * fields merge over the last state so level ticks don't wipe the
 * transcript. No React: this window exists for seconds at a time.
 */

const $ = (id: string): HTMLElement => document.getElementById(id)!
const hudEl = $('hud')
const statusEl = $('status')
const meterEl = $('meter')
const transcriptEl = $('transcript')
const stopBtn = $('stop')
const undoBtn = $('undo')

let state: HudState = { phase: 'capturing' }

/** Dimmed “what you said” + the outcome, both wrapping and scrollable. */
function renderOutcome(message: string): void {
  transcriptEl.innerHTML = ''
  if (state.finalText) {
    const quote = document.createElement('span')
    quote.className = 'hud-quote'
    quote.textContent = `“${state.finalText}”`
    transcriptEl.append(quote)
  }
  const body = document.createElement('span')
  body.className = 'hud-result-text'
  body.textContent = message
  transcriptEl.append(body)
}

function render(): void {
  hudEl.className = `hud hud--${state.phase}`

  const statusText: Record<HudState['phase'], string> = {
    capturing: state.loading ? 'Listening · loading model…' : 'Listening',
    thinking: 'Thinking…',
    result: 'Done',
    error: 'Voice command'
  }
  statusEl.textContent = statusText[state.phase]

  meterEl.style.width =
    state.phase === 'capturing' ? `${Math.min(100, Math.round((state.level ?? 0) * 100))}%` : '0%'

  switch (state.phase) {
    case 'capturing': {
      const confirmed = state.confirmed ?? ''
      const tail = state.tail ?? ''
      if (confirmed || tail) {
        transcriptEl.innerHTML = ''
        transcriptEl.append(confirmed ? confirmed + ' ' : '')
        const tailSpan = document.createElement('span')
        tailSpan.className = 'hud-tail'
        tailSpan.textContent = tail
        transcriptEl.append(tailSpan)
        transcriptEl.scrollTop = transcriptEl.scrollHeight
      } else {
        transcriptEl.innerHTML = `<span class="hud-hint">Speak a command — “add a todo for…”, “mark … as done”</span>`
      }
      break
    }
    case 'thinking':
      renderOutcome('…')
      break
    case 'result':
      renderOutcome(state.summary ?? '')
      break
    case 'error':
      renderOutcome(state.message ?? '')
      break
  }

  stopBtn.classList.toggle('hidden', state.phase !== 'capturing')
  undoBtn.classList.toggle('hidden', !(state.phase === 'result' && state.undoable))
  requestResize()
}

/**
 * Ask main to fit the window to the content (grows downward) instead of
 * scrolling next to empty space. transcript scrollHeight counts the full
 * text even when the current window clips it.
 */
let lastRequestedHeight = 0
function requestResize(): void {
  const chromeHeight = hudEl.offsetHeight - transcriptEl.clientHeight
  const height = chromeHeight + transcriptEl.scrollHeight + 16
  if (Math.abs(height - lastRequestedHeight) < 5) return
  lastRequestedHeight = height
  window.api.hudResize(Math.ceil(height))
}

window.api.onHudState((incoming) => {
  const fresh = incoming.phase !== state.phase
  state = fresh
    ? { ...incoming }
    : {
        ...state,
        ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined))
      }
  render()
})

stopBtn.addEventListener('click', () => window.api.hudAction('stop'))
undoBtn.addEventListener('click', () => window.api.hudAction('undo'))
$('close').addEventListener('click', () => window.api.hudAction('dismiss'))
// Hovering pins the HUD open (main pauses auto-dismiss) so long results
// can be read in full
hudEl.addEventListener('mouseenter', () => window.api.hudAction('hover-in'))
hudEl.addEventListener('mouseleave', () => window.api.hudAction('hover-out'))

render()
