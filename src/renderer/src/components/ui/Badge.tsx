type BadgeSource = 'claude' | 'codex' | 'shell'

interface BadgeProps {
  source: BadgeSource
  className?: string
}

const LABELS: Record<BadgeSource, string> = {
  claude: 'CC',
  codex: 'CX',
  shell: 'SH'
}

/** Source chip — the only per-source color in the app (design/04 §2.6). */
export function Badge({ source, className }: BadgeProps): React.JSX.Element {
  return (
    <span className={`badge badge--${source}${className ? ` ${className}` : ''}`}>
      {LABELS[source]}
    </span>
  )
}
