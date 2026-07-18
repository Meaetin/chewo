type DotTone = 'live' | 'accent' | 'idle'

interface DotProps {
  tone: DotTone
  className?: string
}

/** 8px status dot — never an icon (design/04 §2.12). */
export function Dot({ tone, className }: DotProps): React.JSX.Element {
  return <span className={`dot dot--${tone}${className ? ` ${className}` : ''}`} aria-hidden="true" />
}
