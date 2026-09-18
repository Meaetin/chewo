import type { ReactNode } from 'react'
import { ModalShell } from './ModalShell'
import { Button } from './ui'

export interface ConfirmRequest {
  title: string
  /** One sentence of context above whatever detail the body carries */
  subtitle?: ReactNode
  body?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** `danger` for anything that stops or destroys something */
  intent?: 'primary' | 'danger'
}

interface ConfirmDialogProps extends ConfirmRequest {
  onResolve: (confirmed: boolean) => void
}

/**
 * The app's own confirm, in place of `window.confirm`.
 *
 * The native one is a macOS sheet: it steals the window, renders the message
 * in the system font at the system size, and turns every question into "OK /
 * Cancel" however specific the act was. This one says what the button does,
 * and a dialog about stopping processes can look like one.
 *
 * It blocks the same way the native one did — the caller awaits a promise the
 * buttons resolve — so Escape and the backdrop both mean "no", which is the
 * safe answer for every question worth asking.
 */
export function ConfirmDialog({
  title,
  subtitle,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  intent = 'primary',
  onResolve
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <ModalShell
      title={title}
      subtitle={subtitle}
      onClose={() => onResolve(false)}
      footer={
        <>
          <span className="wt-footer-spacer" />
          <Button onClick={() => onResolve(false)}>{cancelLabel}</Button>
          {/* Focus the answer, not the close button behind it: Enter reaches
              the action the dialog was opened for, Escape already means no. */}
          <Button autoFocus intent={intent} onClick={() => onResolve(true)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </ModalShell>
  )
}
