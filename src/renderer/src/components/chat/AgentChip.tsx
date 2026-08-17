import { createContext, useContext } from 'react'
import { agentIdentity } from '../../../../shared/agent-identity'

/**
 * Who is doing what, as two initials and a colour.
 *
 * The colour comes from the agent's `color` frontmatter when it declared one
 * and from a hash of its name otherwise — so the map has to be shared rather
 * than derived at each site, or an agent that declares `blue` would be blue in
 * the plan panel and hashed-green on its own dispatch chip. A context rather
 * than a prop because the two places that draw one (the plan row and the tool
 * chip) sit at different depths under `ChatPane`, and threading a colour map
 * through the item renderer would touch every chip that is not an agent.
 */
const DeclaredColors = createContext<Map<string, string>>(new Map())

export const AgentColorsProvider = DeclaredColors.Provider

export function AgentChip({
  name,
  title
}: {
  name: string
  title?: string
}): React.JSX.Element {
  const declared = useContext(DeclaredColors)
  const id = agentIdentity(name, declared.get(name))
  return (
    <span
      className="agent-chip"
      title={title ?? name}
      style={{ color: id.color, background: id.background, borderColor: id.color }}
    >
      <span className="agent-chip__mark" aria-hidden="true">
        {id.initials}
      </span>
      <span className="agent-chip__name">{name}</span>
    </span>
  )
}
