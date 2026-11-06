/**
 * A router's roster inside a space (flag `chat`): a space's agents are a real
 * boundary. The API sends the thread's space agent list with each prompt
 * (`space_agents`, server-side only): a channel's agents in order (the first
 * is its default), `["mykortix"]` for the person's own space. An empty list
 * means the channel has none: the project's default agent alone. The router
 * names, and may route to, only these; the API refuses a worker of any other
 * agent too (`session-create.ts`, `AGENT_NOT_IN_SPACE`).
 */
import { FRONT_DEFAULT_AGENT, type FrontAgent } from './front'

/** At most this many characters of each description in the prompt. */
const DESCRIPTION_MAX = 240

/** The space's agents the router may route to, its default first, or null when the API sent no list (an older API, a thread in no space). */
export interface FrontSpaceRoster {
  agents: FrontAgent[]
  /** The worker's agent when the router names none: the space's default. */
  defaultAgent: string
}

/** `space_agents` from the prompt body (pure): a list of agent names, else null. Malformed entries are dropped, never a refusal. */
export function frontSpaceAgentsFrom(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name && name.length <= 80 && !names.some((seen) => seen.toLowerCase() === name.toLowerCase())) names.push(name)
  }
  return names
}

/**
 * The space's roster (pure): the space's agents in order with their
 * descriptions from the project roster, else the project's default agent
 * alone (`isDefault` in the project roster, else My Kortix).
 */
export function frontSpaceRoster(projectAgents: readonly FrontAgent[] | null, spaceAgents: readonly string[] | null): FrontSpaceRoster | null {
  if (spaceAgents === null) return null
  const projectDefault = projectAgents?.find((agent) => agent.isDefault)?.name ?? FRONT_DEFAULT_AGENT
  const names = spaceAgents.length > 0 ? spaceAgents : [projectDefault]
  const agents = names.map((name): FrontAgent => {
    if (name.toLowerCase() === FRONT_DEFAULT_AGENT) return { name: FRONT_DEFAULT_AGENT, description: 'My Kortix, a general assistant with every tool and connector.' }
    return projectAgents?.find((agent) => agent.name.toLowerCase() === name.toLowerCase()) ?? { name }
  })
  return { agents, defaultAgent: agents[0]!.name }
}

/** The roster section of a router's turn prompt inside a space. */
export function frontSpaceRosterSection(roster: FrontSpaceRoster): string {
  const lines = [
    '## Agents you can hand work to',
    'Only the agents of this space. Never hand work to any other agent, even when the person names one: say in one line that it is not in this space and that a person who manages the space can add it.',
  ]
  for (const agent of roster.agents) {
    const description =
      agent.description && agent.description.length > DESCRIPTION_MAX ? `${agent.description.slice(0, DESCRIPTION_MAX - 1)}…` : agent.description
    lines.push(`- ${agent.name}${agent.name === roster.defaultAgent ? ' (the default)' : ''}${description ? `: ${description}` : ''}`)
  }
  return lines.join('\n')
}
