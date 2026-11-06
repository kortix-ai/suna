/**
 * The router (flag `chat_front`): the agent a person chats with in a space
 * thread. It keeps the conversation and does quick work itself with its
 * agent's own tools (an answer, a read of the thread files, a short text, one
 * lookup). Longer work goes to a hidden worker session: any project agent the router picks from the roster in its
 * prompt, or My Kortix (`mykortix`) when no agent fits. Each worker has a
 * name per task; a later `agent` call with that name continues it. A worker's
 * report comes back to the router as a notice, and the router writes the
 * person only what matters, like a person in a chat.
 *
 * The conversation is never copied: it is the thread's session log, which
 * every agent reads with `kortix sessions log <id>`. The thread folder (the
 * API's `memory/thread-files.ts`) holds only work/ and results/, and every
 * session of the thread mounts it. The router hands work over by reference:
 * `frontCall` ends every worker prompt with a "Context files" block
 * (`frontContextBlock`: the thread's session, the thread folder, the space's
 * context.md and the worker's own `work/<name>/` folder) from the prompt
 * body's `thread_files`, which only the API sets. Without them (an older API, a thread with no Drive) the prompt
 * goes as the model wrote it.
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

import { withWorkspaceRouteFallback } from '@/lib/kortix-api/workspace-routes'

/** `runtime_context` key: this session is a router (a front). */
export const FRONT_CONTEXT_KEY = 'kortix.front'
/** `runtime_context` key: this session is the worker of a router. */
export const FRONT_THREAD_CONTEXT_KEY = 'kortix.front.thread'

/** The hand-off tools a front always has, beside its agent's own tools. */
export const FRONT_TOOLS: readonly string[] = ['agent', 'send_message', 'task_stop']

/** The worker's agent when the router names none, or none fits: My Kortix, with every tool. */
export const FRONT_DEFAULT_AGENT = 'mykortix'

/** How long a read roster stays fresh before the next turn reads it again. */
export const FRONT_AGENTS_TTL_MS = 60_000
/** The roster read's wall-clock limit: a slow read never holds a turn longer. */
export const FRONT_AGENTS_TIMEOUT_MS = 4_000
/** At most this many agents in the prompt, and this many characters of each description. */
const ROSTER_MAX = 40
const DESCRIPTION_MAX = 240

/** In the worker's system prompt: its answer reaches the thread once, as its run's report; its full result stays in the thread's results/ folder. */
export const FRONT_WORKER_NOTE =
  "## Your report\nA person talks to you through a chat thread. Your final answer goes back to that thread by itself, once, when your run ends. Never send_message the session that started you; end your run with the answer instead. Write the answer for the person: the result first, then any decision or input you need from them.\nWhen your prompt ends with \"Context files\", read the conversation it names (its session log, with the kortix CLI) and context.md first, keep your scratch files in your work folder, and write your full result to the result file the block names. End your run with only that file's path and a one-line summary: the router links the file and never retypes it."

export const FRONT_PROMPT = [
  'You are Kortix, talking with a person in a chat thread. You are the router of this thread: the one the person talks to, and the one who talks to every agent behind it. Do quick work yourself. Hand longer work to the agents of this space.',
  '',
  '## Write like a person',
  '- Short, warm and natural, like a capable assistant in a chat. Usually one or two sentences, unless the person asked for a longer text.',
  '- No technical dumps, tool names, step lists, logs or explanations of how you work, unless the person asks.',
  '- Never invent a result. Never say an agent did what you did, or that you did what an agent did.',
  '- You may name who is on it in plain words ("I\'ll have research look into it"). Never mention sessions, tools, task ids or handles.',
  '',
  '## Do it yourself when it is quick',
  '- Do it yourself: an answer from what you know, reading or searching this conversation, the thread folder and the space folder, a short piece of writing (a message, a summary, a poem, a translation), or one quick lookup. Reply with the result at once.',
  '- Hand it off when it is multi-step, runs longer than a minute or two, needs an agent\'s own connectors or skills, or the person names an agent of this space.',
  '- Greetings, thanks, small talk and questions about this conversation: answer yourself, in one line.',
  '- A deliverable longer than about ten lines (a report, a document, a plan, code), whoever wrote it: it lives in a file in the thread folder or the space folder. Reply with one or two lines and link the file: `[<file name>](<path>)`. Never paste it into the chat.',
  '',
  '## Hand off longer work',
  '- A new hand-off: call `agent` once. `subagent_type`: the agent below whose description fits the request best; leave it out for the default. `name`: a short lowercase name for this piece of work, such as "flight-search". `description`: a few words. `prompt`: what to do, in a line or two, plus anything from this thread the agent needs that is not in a file.',
  '- Every agent can read this conversation itself (see "Thread files" below, when it is there): never retype it. A "Context files" block with the conversation, the paths and the agent\'s result file is added to every prompt you send. With no thread files, put the person\'s words in full in `prompt`: the agent sees nothing of this thread otherwise.',
  '- Several independent requests in one message: one `agent` call each, in the same reply.',
  '- A follow-up, an answer or a correction for work you already handed off: call `agent` with the same `name`. That continues the same agent with everything it knows. When the call says it is still working: `send_message` to that name with the person\'s words and `notify_when_idle: true`.',
  '- "Stop" or "cancel": `task_stop` with that name.',
  '- A request that is genuinely ambiguous, where a wrong guess wastes real work: ask ONE short question first. Otherwise act at once; never ask for what you can pass on.',
  '',
  '## After you hand off',
  '- One short line at most ("On it." or "Got it, I\'ll have research look into it."), or nothing.',
  '- Do not wait or check on it. The result comes to you as a message.',
  '',
  '## When results come back',
  '- The agent writes its full result to a file and reports the path and one line. Reply with that one line and link the file: `[<file name>](<path>)`. Never paste or retype the agent\'s full text; read the file only when you need a detail for your one line.',
  '- Keep links and names exactly as the agent wrote them. Several updates at once: one combined message, most important first.',
  '- The agent asked the person through its own question or approval card (it waits in Review and in this thread): write only one line, `Needs you: <the card\'s header>`, and nothing else. Never answer it yourself, never repeat its options; the person answers on the card and the agent goes on.',
  '- The agent needs the person in its report text only (no card): ask it as your own question, in one line. Pass the answer back with `agent` or `send_message` to the same name.',
  '- An update with nothing new for the person: say nothing. Never repeat what you already said.',
  '- A hand-off failed: say so in one line, and what you need or will try next.',
].join('\n')

/** One project agent the router may route to. */
export interface FrontAgent {
  name: string
  description?: string
  /** The project's default agent (`config.default_agent`): a space with no agents routes to it (front-space.ts). */
  isDefault?: boolean
}

/** A thread's files as this box mounts them, from the prompt body's `thread_files` (the API sets it). */
export interface FrontThreadFiles {
  /** The thread folder: `work/`, `results/`. */
  folder: string
  /** The space's brief. */
  context: string
  /** The thread's root session: its session log is the conversation. */
  session?: string
}

/** What the `agent` tool's handler needs to route a front's call. */
export interface FrontRouter {
  /** The agents the router may name; null when the roster did not load (the API then authorizes the name). */
  agents: readonly string[] | null
  /** The thread's files; null or absent when the API sent none. */
  files?: FrontThreadFiles | null
  /** Inside a space (front-space.ts): `agents` is the whole roster, My Kortix included only when the space has it, and this is its default. */
  spaceDefault?: string | null
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

/** A sandbox path the API sent: absolute, one line, no `..`, at most 512 characters. */
const SAFE_PATH = /^\/[^\0\r\n]{0,511}$/
const safePath = (path: unknown): path is string => typeof path === 'string' && SAFE_PATH.test(path) && !path.split('/').includes('..')

/** A session id the API sent: a UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The prompt body's `thread_files`, or null when it is missing or malformed. */
export function frontThreadFilesFrom(raw: unknown): FrontThreadFiles | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (!safePath(record.folder) || !safePath(record.context)) return null
  const session = typeof record.session === 'string' && SESSION_ID.test(record.session) ? record.session : null
  return { folder: record.folder.replace(/\/+$/, ''), context: record.context, ...(session ? { session } : {}) }
}

/**
 * The block every worker prompt of a router ends with (pure): the thread's
 * conversation by session id, its files by path, and the worker's own folder
 * (`work/<name>/`) when its name is known.
 */
export function frontContextBlock(files: FrontThreadFiles, name: string | null): string {
  const work = name ? `${files.folder}/work/${name}` : null
  return [
    '## Context files',
    'This task comes from a chat thread. Read the conversation before you start: it is the person\'s own words.',
    ...(files.session ? [`- The conversation: \`kortix sessions log ${files.session} -n 50\` (always current; \`--json\` for scripts, pipe to rg or jq to search). Never copy it into a file.`] : []),
    `- The thread folder: ${files.folder}/ (work/ holds each agent's work, results/ each agent's full result)`,
    `- The space's brief: ${files.context}`,
    ...(work ? [`- Your work folder: ${work}/ (keep your scratch files here)`] : []),
    ...(name ? [`- Your result file: ${files.folder}/results/${name}-<n>.md, <n> the next free number from 1. Write your full result there; end your run with only its path and a one-line summary.`] : []),
  ].join('\n')
}

/** The prompt with the Context files block at its end; as it was without thread files. */
function withContextFiles(prompt: string, files: FrontThreadFiles | null | undefined, name: string | null): string {
  if (!files) return prompt
  return `${prompt.trimEnd()}\n\n${frontContextBlock(files, name)}`
}

/**
 * Route one `agent` call of a front: the named project agent, or My Kortix
 * when the call names none. A name the roster does not hold is refused with
 * the roster, so the model picks again. A `task_id` continues that worker as
 * it was. Model, inline spec, fork, team and session are never the model's
 * choice here. With thread files, the prompt ends with the Context files block.
 */
export function frontCall(input: FrontCallInput, router: FrontRouter): FrontCall {
  const base = { description: input.description, session: 'separate' as const, run_in_background: true as const }
  if (typeof input.task_id === 'string' && input.task_id.trim()) {
    const given = typeof input.name === 'string' ? input.name.trim().replace(/^@/, '') : ''
    return { ...base, prompt: withContextFiles(input.prompt, router.files, HANDLE.test(given) ? given : null), task_id: input.task_id.trim() }
  }
  const requested = typeof input.subagent_type === 'string' ? input.subagent_type.trim().replace(/^@/, '') : ''
  const name = frontTaskName(input.description, input.name)
  const prompt = withContextFiles(input.prompt, router.files, name)
  const inSpace = typeof router.spaceDefault === 'string' && router.agents !== null
  if (!requested) return { ...base, prompt, subagent_type: inSpace ? router.spaceDefault! : FRONT_DEFAULT_AGENT, name }
  if (!inSpace && requested.toLowerCase() === FRONT_DEFAULT_AGENT) return { ...base, prompt, subagent_type: FRONT_DEFAULT_AGENT, name }
  if (router.agents !== null) {
    const match = router.agents.find((agent) => agent.toLowerCase() === requested.toLowerCase())
    if (!match) {
      throw new Error(
        inSpace
          ? `"${requested}" is not an agent of this space. Pick one of: ${router.agents.join(', ')}.`
          : `"${requested}" is not an agent of this project. Pick one of: ${[FRONT_DEFAULT_AGENT, ...router.agents].join(', ')}.`,
      )
    }
    return { ...base, prompt, subagent_type: match, name }
  }
  return { ...base, prompt, subagent_type: requested, name }
}

/**
 * The project agents a front may route to, from a `/detail` response: every
 * enabled agent a picker offers, except platform agents (My Kortix is the
 * default and always listed first). Null when the response has no agent list.
 */
export function frontAgentsFromDetail(detail: unknown): FrontAgent[] | null {
  const config = (detail as { config?: { agents?: unknown; default_agent?: unknown } } | null)?.config
  if (!config || !Array.isArray(config.agents)) return null
  const agents: FrontAgent[] = []
  for (const entry of config.agents as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue
    if (entry.enabled === false || entry.hidden === true || entry.platform === true) continue
    if (entry.name.toLowerCase() === FRONT_DEFAULT_AGENT) continue
    const description = typeof entry.description === 'string' ? entry.description.replace(/\s+/g, ' ').trim() : ''
    agents.push({ name: entry.name, ...(description ? { description } : {}), ...(entry.name === config.default_agent ? { isDefault: true } : {}) })
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
    const res = await withWorkspaceRouteFallback(fetchImpl)(`${origin}/v1/workspaces/${encodeURIComponent(api.projectId)}/detail`, {
      headers: { authorization: `Bearer ${api.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return frontAgentsFromDetail(await res.json())
  } catch {
    return null
  }
}
