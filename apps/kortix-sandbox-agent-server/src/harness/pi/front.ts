/**
 * The intake agent (flag `chat_front`): the agent a person chats with in a
 * space thread. It only talks and routes. The front session has three tools
 * (`agent`, `send_message`, `task_stop`). Each piece of work goes to a hidden
 * worker session: any project agent the intake picks from the roster in its
 * prompt, or My Kortix (`mykortix`) when no agent fits. Each worker has a
 * name per task; a later `agent` call with that name continues it. A worker's
 * report comes back to the intake as a notice, and the intake writes the
 * person only what matters, like a person in a chat.
 *
 * The roster (`frontAgentsSection`) is read from the project's `/detail`
 * (`config.agents`: the same list `kortix agents ls` and the web Agents page
 * read) at the start of each turn, cached for `FRONT_AGENTS_TTL_MS`. A failed
 * read keeps the last list; with no list, any name passes and the API
 * authorizes it when it creates the session.
 *
 * The API marks a front session with `kortix.front` in its runtime_context
 * (`FRONT_CONTEXT_KEY`) from server-side state only; a person cannot set a
 * `kortix.` key. The front marks each worker with `kortix.front.thread`
 * (`FRONT_THREAD_CONTEXT_KEY`), which adds `FRONT_WORKER_NOTE` to the
 * worker's system prompt.
 */

/** `runtime_context` key: this session is a talk-only front. */
export const FRONT_CONTEXT_KEY = 'kortix.front'
/** `runtime_context` key: this session is the worker of a talk-only front. */
export const FRONT_THREAD_CONTEXT_KEY = 'kortix.front.thread'

/** The only tools a front session has. */
export const FRONT_TOOLS: readonly string[] = ['agent', 'send_message', 'task_stop']

/** The worker's agent when the intake names none, or none fits: My Kortix, with every tool. */
export const FRONT_DEFAULT_AGENT = 'mykortix'

/** How long a read roster stays fresh before the next turn reads it again. */
export const FRONT_AGENTS_TTL_MS = 60_000
/** The roster read's wall-clock limit: a slow read never holds a turn longer. */
export const FRONT_AGENTS_TIMEOUT_MS = 4_000
/** At most this many agents in the prompt, and this many characters of each description. */
const ROSTER_MAX = 40
const DESCRIPTION_MAX = 240

/** In the worker's system prompt: its answer reaches the thread once, as its run's report. */
export const FRONT_WORKER_NOTE =
  "## Your report\nA person talks to you through a chat thread. Your final answer goes back to that thread by itself, once, when your run ends. Never send_message the session that started you; end your run with the answer instead. Write the answer for the person: the result first, then any decision or input you need from them."

export const FRONT_PROMPT = [
  'You are Kortix, talking with a person in a chat thread. You are the one they talk to. A team of agents does the work behind you: you hand each request to the right agent and write back to the person. You cannot read, search, run or change anything yourself.',
  '',
  '## Write like a person',
  '- Short, warm and natural, like a capable assistant in a chat. Usually one or two sentences.',
  '- No technical dumps, file paths, tool names, step lists, logs or explanations of how you work, unless the person asks.',
  '- Never say or suggest that you did the work yourself. Never invent a result.',
  '- You may name who is on it in plain words ("I\'ll have research look into it"). Never mention sessions, tools, task ids or handles.',
  '',
  '## Route the work',
  '- You never do a task yourself, however small or quick. Writing anything (a poem, a message, a summary, a translation), a fact, a lookup, a calculation or an opinion that needs knowledge: every one goes to an agent. Never write the content yourself and never say an agent is not needed.',
  '- A new request: call `agent` once. `subagent_type`: the project agent below whose description fits the request best; `' + FRONT_DEFAULT_AGENT + '` only when no agent below fits or you are unsure. `name`: a short lowercase name for this piece of work, such as "flight-search". `description`: a few words. `prompt`: the person\'s words in full, plus anything from this thread the agent needs. The agent sees nothing of this thread, so never drop a detail.',
  '- Several independent requests in one message: one `agent` call each, in the same reply.',
  '- A follow-up, an answer or a correction for work you already handed off: call `agent` with the same `name`. That continues the same agent with everything it knows. When the call says it is still working: `send_message` to that name with the person\'s words and `notify_when_idle: true`.',
  '- "Stop" or "cancel": `task_stop` with that name.',
  '- A request that is genuinely ambiguous, where a wrong guess wastes real work: ask ONE short question first. Otherwise hand it off at once; never ask for what you can pass on.',
  '- Only greetings, thanks, small talk or a question about this conversation itself: answer yourself, in one line. Anything else is a request: hand it off.',
  '',
  '## After you hand off',
  '- One short line at most ("On it." or "Got it, I\'ll have research look into it."), or nothing.',
  '- Do not wait or check on it. The result comes to you as a message.',
  '',
  '## When results come back',
  '- Tell the person the outcome as a person would: the answer, a link, or the decision they need to make. Lead with the point. Keep links and names exactly as the agent wrote them.',
  '- Several updates at once: one combined message, most important first.',
  '- The agent needs the person (a question, an approval, a sign-in): ask it as your own question, in one line. Pass the answer back with `agent` or `send_message` to the same name.',
  '- An update with nothing new for the person: say nothing. Never repeat what you already said.',
  '- A hand-off failed: say so in one line, and what you need or will try next.',
].join('\n')

/** One project agent the intake may route to. */
export interface FrontAgent {
  name: string
  description?: string
}

/** What the `agent` tool's handler needs to route a front's call. */
export interface FrontRouter {
  /** The agents the intake may name; null when the roster did not load (the API then authorizes the name). */
  agents: readonly string[] | null
}

/** The `agent` call fields a front reads. Everything else the model passes is ignored. */
export interface FrontCallInput {
  description: string
  prompt: string
  subagent_type?: string
  name?: string
  task_id?: string
}

/** The call a front makes: always a separate session in the background. */
export interface FrontCall {
  description: string
  prompt: string
  subagent_type?: string
  name?: string
  task_id?: string
  session: 'separate'
  run_in_background: true
}

/** The child-name grammar (`AGENT_HANDLE` in cloud-subagent.ts). */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

/** The worker's name: the model's, else a slug of the description, else `task`. */
export function frontTaskName(description: string, name?: string): string {
  const given = typeof name === 'string' ? name.trim().replace(/^@/, '') : ''
  if (HANDLE.test(given)) return given
  const slug = `${given} ${description}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return HANDLE.test(slug) ? slug : 'task'
}

/**
 * Route one `agent` call of a front: the named project agent, or My Kortix
 * when the call names none. A name the roster does not hold is refused with
 * the roster, so the model picks again. A `task_id` continues that worker as
 * it was. Model, inline spec, fork, team and session are never the model's
 * choice here.
 */
export function frontCall(input: FrontCallInput, router: FrontRouter): FrontCall {
  const base = { description: input.description, prompt: input.prompt, session: 'separate' as const, run_in_background: true as const }
  if (typeof input.task_id === 'string' && input.task_id.trim()) return { ...base, task_id: input.task_id.trim() }
  const requested = typeof input.subagent_type === 'string' ? input.subagent_type.trim().replace(/^@/, '') : ''
  const name = frontTaskName(input.description, input.name)
  if (!requested || requested.toLowerCase() === FRONT_DEFAULT_AGENT) return { ...base, subagent_type: FRONT_DEFAULT_AGENT, name }
  if (router.agents !== null) {
    const match = router.agents.find((agent) => agent.toLowerCase() === requested.toLowerCase())
    if (!match) {
      throw new Error(`"${requested}" is not an agent of this project. Pick one of: ${[FRONT_DEFAULT_AGENT, ...router.agents].join(', ')}.`)
    }
    return { ...base, subagent_type: match, name }
  }
  return { ...base, subagent_type: requested, name }
}

/**
 * The project agents a front may route to, from a `/detail` response: every
 * enabled agent a picker offers, except platform agents (My Kortix is the
 * default and always listed first). Null when the response has no agent list.
 */
export function frontAgentsFromDetail(detail: unknown): FrontAgent[] | null {
  const config = (detail as { config?: { agents?: unknown } } | null)?.config
  if (!config || !Array.isArray(config.agents)) return null
  const agents: FrontAgent[] = []
  for (const entry of config.agents as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue
    if (entry.enabled === false || entry.hidden === true || entry.platform === true) continue
    if (entry.name.toLowerCase() === FRONT_DEFAULT_AGENT) continue
    const description = typeof entry.description === 'string' ? entry.description.replace(/\s+/g, ' ').trim() : ''
    agents.push({ name: entry.name, ...(description ? { description } : {}) })
  }
  return agents
}

/** The roster section of a front's turn prompt. */
export function frontAgentsSection(agents: readonly FrontAgent[] | null): string {
  const lines = ['## Agents you can hand work to', `- ${FRONT_DEFAULT_AGENT} (the default): My Kortix, a general assistant with every tool and connector. Use it when no agent below fits.`]
  if (agents === null) return [...lines, 'The list of this project\'s other agents did not load. Hand work to ' + FRONT_DEFAULT_AGENT + ', unless the person names an agent.'].join('\n')
  if (agents.length === 0) return [...lines, 'This project has no other agents: hand everything to ' + FRONT_DEFAULT_AGENT + '.'].join('\n')
  for (const agent of agents.slice(0, ROSTER_MAX)) {
    const description = agent.description && agent.description.length > DESCRIPTION_MAX ? `${agent.description.slice(0, DESCRIPTION_MAX - 1)}…` : agent.description
    lines.push(`- ${agent.name}${description ? `: ${description}` : ''}`)
  }
  if (agents.length > ROSTER_MAX) lines.push(`(${agents.length - ROSTER_MAX} more agents are not listed.)`)
  return lines.join('\n')
}

/** Read the roster from `GET /v1/projects/:id/detail`. Null on any failure; never throws. */
export async function fetchFrontAgents(
  api: { apiUrl: string; projectId: string; token: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FRONT_AGENTS_TIMEOUT_MS,
): Promise<FrontAgent[] | null> {
  const trimmed = api.apiUrl.trim().replace(/\/+$/, '')
  const origin = trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
  try {
    const res = await fetchImpl(`${origin}/v1/projects/${encodeURIComponent(api.projectId)}/detail`, {
      headers: { authorization: `Bearer ${api.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return frontAgentsFromDetail(await res.json())
  } catch {
    return null
  }
}
