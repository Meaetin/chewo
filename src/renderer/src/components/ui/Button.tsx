import { WorkingText } from './WorkingText'

type ButtonIntent = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'default' | 'compact' | 'icon'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  intent?: ButtonIntent
  size?: ButtonSize
  /** Square, no gap — pairs with `size="icon"` for a bare-glyph action. */
  iconOnly?: boolean
  /** Swaps the label for a mono WorkingText status, holds width, sets aria-busy. */
  loading?: boolean
  /** Status shown while `loading` (design/05: "Checking…", "Structuring…", …). */
  loadingText?: string
  leadingIcon?: React.ReactNode
}

/** The one button. Four intents, dark ink on the accent fill (design/04 §2.1). */
export function Button({
  intent = 'secondary',
  size = 'default',
  iconOnly = false,
  loading = false,
  loadingText = 'Working…',
  leadingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = [
    'btn',
    `btn--${intent}`,
    size !== 'default' ? `btn--${size}` : '',
    iconOnly ? 'btn--icon-only' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      {leadingIcon && <span className="btn__icon">{leadingIcon}</span>}
      {children}
    </>
  )

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <>
          {/* Kept in flow but hidden so the button holds its resting width. */}
          <span className="btn__label btn__label--held" aria-hidden="true">
            {content}
          </span>
          <WorkingText className="btn__loading">{loadingText}</WorkingText>
        </>
      ) : (
        content
      )}
    </button>
  )
}
