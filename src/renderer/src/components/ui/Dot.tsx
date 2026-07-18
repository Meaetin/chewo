type DotTone = 'live' | 'accent' | 'idle' | 'danger'

interface DotProps {
  tone: DotTone
  /** Breathing pulse — the one sanctioned rest-loop, for the recording dot (design/05 §4d). */
  pulse?: boolean
  className?: string
}

/** 8px status dot — never an icon (design/04 §2.12). */
export function Dot({ tone, pulse = false, className }: DotProps): React.JSX.Element {
  const classes = ['dot', `dot--${tone}`, pulse ? 'dot--pulse' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return <span className={classes} aria-hidden="true" />
}
