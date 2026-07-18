type InputVariant = 'text' | 'search' | 'textarea'

interface InputOwnProps {
  mono?: boolean
  leadingIcon?: React.ReactNode
}

export type InputProps =
  | (InputOwnProps & {
      variant?: 'text' | 'search'
    } & React.InputHTMLAttributes<HTMLInputElement>)
  | (InputOwnProps & {
      variant: 'textarea'
    } & React.TextareaHTMLAttributes<HTMLTextAreaElement>)

/** Lucide-style magnifier; inlined until lucide-react lands (Phase 3). */
function SearchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10.5 10.5L13.5 13.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** One input recipe. Accent border + wash glow on focus (design/04 §2.2). */
export function Input(props: InputProps): React.JSX.Element {
  const { variant = 'text', mono = false, leadingIcon, className, ...rest } = props

  const icon = variant === 'search' ? <SearchIcon /> : leadingIcon
  const showIcon = variant !== 'textarea' && Boolean(icon)

  const classes = [
    'input',
    mono ? 'input--mono' : '',
    variant === 'textarea' ? 'input--textarea' : '',
    showIcon ? 'input--with-leading' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  if (variant === 'textarea') {
    return (
      <textarea className={classes} {...(rest as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} />
    )
  }

  const field = (
    <input
      type={variant === 'search' ? 'search' : 'text'}
      className={classes}
      {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
    />
  )

  if (!showIcon) return field

  return (
    <span className="input-field">
      <span className="input-field__icon">{icon}</span>
      {field}
    </span>
  )
}
