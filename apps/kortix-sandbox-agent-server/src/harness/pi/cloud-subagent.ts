/**
 * Separate-session subagent spawn: the `agent` tool's `session: "separate"`
 * (the default) as a REAL Kortix child session.
 *
 * RFC `.agents/skills/learnings/work/claude-code-harness-parity/README.md`,
 * Pillar 1 (the keystone). The model picks the session per call
 * (`extensions/subagents.ts`); `routeSubagent` below decides where the call
 * runs. A separate call runs here when the box has a control plane. Otherwise
 * it runs in this session (`PiRuntime.spawnSession`), and the tool result says
 * why.
 * A spawn is one `POST /v1/projects/:id/sessions` from this box, which
 * provisions the child its own sandbox + pi and runs the prompt. The child
 * auto-links to this session as its parent: the box's `KORTIX_TOKEN` is
 * session-bound, and the API reads the caller session from it
 * (`middleware/caller-session.ts` → `session-create.ts` `parentSessionId` and
 * `metadata.spawned_by_session`). That same link authorizes every later read
 * of the child from this box (`agentSessionStanding`, connectors/share.ts):
 * the session row, its transcript, a follow-up prompt, a stop.
 *
 * The return shape is `SpawnSessionResult`, identical to the in-process path:
 * the tool part carries the child id in `metadata.sessionId` and the output
 * starts `task_id: <id>`.
 *
 * What a child gets, and why it never has more than its parent:
 *  - A named project agent (`subagent_type: reviewer`) runs as that agent. The
 *    API authorizes the agent exactly as for any session the caller starts.
 *  - A built-in (`general`, `explore`) or an inline spec runs as the PARENT's
 *    own resolved agent (runtime.ts `cloudParent`), so its connectors, secrets
 *    and permissions are the parent's. The platform coordinator omits
 *    `agent_name`: the API then picks the project default (session-create.ts,
 *    the coordinator recursion stop).
 *  - The spec's instructions ride in `initial_context` (a model-only part).
 *  - The parent's effective tool list, intersected with the spec's list, rides
 *    in `runtime_context` (`kortix.subagent.tools`) for EVERY child, named
 *    agents included. The child's runtime narrows its own tools to it
 *    (runtime.ts `rootToolAllowed`), so a child never has a tool its parent
 *    lacks, the same rule as the in-process path.
 *  - Not forwarded: `variant` (a named child applies its own agent's variant;
 *    a built-in or inline spec has none) and the spec `permission` (the child
 *    runs under its agent's permission policy, never a wider one).
 *
 * Guardrails: at most `maxLive` children wait at once per parent box, and a
 * child at depth `maxDepth` cannot start another separate child (depth rides in
 * `runtime_context` as `kortix.subagent.depth`). Both refuse with an error
 * that names `session: "same"` as the way out. An aborted parent call stops
 * its child.
 */
import { logger } from '@/lib/log/logger'
import type { SpawnSessionInput, SpawnSessionResult, SubagentSession } from './extensions/subagents'

/** Why a separate call ran in this session instead. The tool result carries it to the model. */
export const NO_CONTROL_PLANE_NOTICE =
  'This session has no Kortix control plane to start a separate session from, so the subagent ran inside this session.'

/**
 * Where one `agent` call runs. A `task_id` resumes the child where it was
 * created: a child this session holds in process is `same`, any other id is
 * a separate session. A new call runs where `requested` says (default
 * `separate`). A separate call the box cannot serve runs in
 * this session, with a notice; it never fails.
 */
export function routeSubagent(input: {
  requested?: SubagentSession
  taskId?: string
  /** The task_id names a child this session runs in process. */
  localChild: boolean
  /** The box can reach its control plane (`cloudSubagentApiFrom` is not null). */
  controlPlane: boolean
}): { session: SubagentSession; notice?: string } {
  if (input.taskId) return { session: input.localChild ? 'same' : 'separate' }
  if (input.requested === 'same') return { session: 'same' }
  if (!input.controlPlane) return { session: 'same', notice: NO_CONTROL_PLANE_NOTICE }
  return { session: 'separate' }
}

/** `runtime_context` key: this session's subagent depth (a root session has none = 0). */
export const SUBAGENT_DEPTH_KEY = 'kortix.subagent.depth'
/** `runtime_context` key: comma-separated tool names this session may use (absent = no narrowing). */
export const SUBAGENT_TOOLS_KEY = 'kortix.subagent.tools'

/** Defaults for the two guardrails; the box env can override both (config.ts). */
export const DEFAULT_MAX_LIVE_CLOUD_SUBAGENTS = 4
export const DEFAULT_MAX_CLOUD_SUBAGENT_DEPTH = 2

/** The API's caps on the two create fields this module fills (`@kortix/api-contract`). */
const INITIAL_CONTEXT_MAX_CHARS = 8_192
const RUNTIME_CONTEXT_STRING_MAX = 4_096
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/

/** The API callback target and this parent's limits, from the box env. */
export interface CloudSubagentApi {
  /** `KORTIX_API_URL`, with or without the `/v1` suffix. */
  apiUrl: string
  projectId: string
  /** The session's sandbox token (`KORTIX_TOKEN`); its bearer identifies this session as the parent. */
  token: string
  /** This box's own session id (`KORTIX_SESSION_ID`): a resumed `task_id` must name one of its children. */
  sessionId?: string
  /** The parent's resolved agent, set per call. Built-in and inline children run as it. Absent: the API picks. */
  parentAgent?: string
  /** This session's own subagent depth (0 for a root session). */
  depth: number
  maxDepth: number
  maxLive: number
  /** Every tool the parent agent may use, set per call. A child gets at most these. Absent: the parent is not narrowed. */
  toolAllowlist?: string[]
  /** Children this parent is waiting on right now. One counter per box, shared by every call. */
  live: { count: number }
  fetchImpl?: typeof fetch
}

/** What a session's own `runtime_context` says about it as a subagent. */
export interface SubagentContext {
  depth: number
  tools?: string[]
}

/** Parse `KORTIX_SESSION_CONTEXT` (the API's JSON envelope of `runtime_context`). Malformed = a root session. */
export function subagentContextFrom(raw: string | undefined): SubagentContext {
  if (!raw?.trim()) return { depth: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { depth: 0 }
  }
  if (!parsed || typeof parsed !== 'object') return { depth: 0 }
  const record = parsed as Record<string, unknown>
  const rawDepth = record[SUBAGENT_DEPTH_KEY]
  const depth = typeof rawDepth === 'number' && Number.isInteger(rawDepth) && rawDepth > 0 ? rawDepth : 0
  const rawTools = record[SUBAGENT_TOOLS_KEY]
  if (typeof rawTools !== 'string') return { depth }
  // A present key always narrows: an empty or all-invalid list means no tools, never all tools.
  return { depth, tools: rawTools.split(',').map((name) => name.trim()).filter((name) => TOOL_NAME.test(name)) }
}

/** Resolve the callback target, or null when the box has no control plane (a local/offline box). */
export function cloudSubagentApiFrom(input: {
  apiUrl?: string
  projectId?: string
  sandboxToken?: string
  sessionId?: string
  context?: SubagentContext
  maxLive?: number
  maxDepth?: number
}): CloudSubagentApi | null {
  const apiUrl = input.apiUrl?.trim()
  const projectId = input.projectId?.trim()
  const token = input.sandboxToken?.trim()
  if (!apiUrl || !projectId || !token) return null
  return {
    apiUrl,
    projectId,
    token,
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    depth: input.context?.depth ?? 0,
    maxDepth: input.maxDepth ?? DEFAULT_MAX_CLOUD_SUBAGENT_DEPTH,
    maxLive: input.maxLive ?? DEFAULT_MAX_LIVE_CLOUD_SUBAGENTS,
    ...(input.context?.tools ? { toolAllowlist: input.context.tools } : {}),
    live: { count: 0 },
  }
}

/** `https://api.example.com/v1` → `https://api.example.com`. `/v1` is part of every path below. */
function apiOrigin(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/** `provider/model` → the two fields `onSession`/the result report. Best-effort; informational only. */
function splitModel(ref: string | undefined): { providerID: string; modelID: string } {
  if (!ref) return { providerID: 'kortix', modelID: 'default' }
  const slash = ref.indexOf('/')
  return slash < 0 ? { providerID: 'kortix', modelID: ref } : { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

/** Built-in subagent names and the inline label: none is a real project agent, so the child runs as the parent's agent. */
const CLOUD_UNMAPPABLE_AGENTS = new Set(['general', 'explore', 'inline'])

/** Poll the child session until it goes idle, at most this long. */
// ponytail: fixed 30 min ceiling + 2 s poll; make it env-tunable if a real subagent run needs longer.
const WAIT_CEILING_MS = 30 * 60_000
const POLL_INTERVAL_MS = 2_000
/** Messages read back from the child's transcript to find its last report. */
const READ_BACK_MESSAGES = 20

export interface CloudSubagentOptions {
  waitCeilingMs?: number
  pollIntervalMs?: number
  now?: () => number
}

interface Http {
  fetchImpl: typeof fetch
  origin: string
  headers: Record<string, string>
  projectId: string
}

interface SessionRow {
  session_id?: string
  status?: string
  parent_session_id?: string | null
  working?: { state?: string; since?: string | null; pending_delivery?: boolean }
}

function sessionUrl(http: Http, childId: string, suffix = ''): string {
  return `${http.origin}/v1/projects/${encodeURIComponent(http.projectId)}/sessions/${encodeURIComponent(childId)}${suffix}`
}

/** The tools a child may use: the spec's list, inside this session's own list. Undefined = no narrowing. */
export function childToolAllowlist(own: string[] | undefined, requested: string[] | undefined): string[] | undefined {
  if (!own) return requested
  if (!requested) return own
  return requested.filter((name) => own.includes(name))
}

/**
 * Spawn one real cloud child session for an `agent`-tool call (or send a
 * follow-up to an existing one for `task_id`) and wait for its turn to
 * settle. Returns the same shape as the in-process spawn. A refused call
 * throws, like the in-process gates do.
 */
export async function cloudSpawnSession(
  api: CloudSubagentApi,
  input: SpawnSessionInput,
  opts: CloudSubagentOptions = {},
): Promise<SpawnSessionResult> {
  const model = splitModel(input.model)
  const http: Http = {
    fetchImpl: api.fetchImpl ?? fetch,
    origin: apiOrigin(api.apiUrl),
    headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
    projectId: api.projectId,
  }
  if (input.sessionId) return resumeChild(api, http, input, model, opts)

  if (api.depth >= api.maxDepth) {
    throw new Error(
      `Separate subagent sessions nest at most ${api.maxDepth} levels and this session is level ${api.depth}. Pass session: "same" to run it inside this session, or do the task here.`,
    )
  }
  const createBody = buildCreateBody(api, input)
  if (api.live.count >= api.maxLive) {
    throw new Error(
      `At most ${api.maxLive} separate subagent sessions run at once for one session, and ${api.live.count} are running. Wait for one to return, or pass session: "same" to run this one inside this session.`,
    )
  }
  // Reserved before the first await: parallel `agent` calls in one message all pass through here.
  api.live.count += 1
  try {
    let created: Response
    try {
      created = await http.fetchImpl(`${http.origin}/v1/projects/${encodeURIComponent(api.projectId)}/sessions`, {
        method: 'POST',
        headers: http.headers,
        body: JSON.stringify(createBody),
      })
    } catch (err) {
      return { sessionId: '', status: 'error', text: '', error: `child session create failed: ${errorText(err)}`, model }
    }
    if (created.status !== 201 && created.status !== 202) {
      const body = (await created.text().catch(() => '')).slice(0, 500)
      return { sessionId: '', status: 'error', text: '', error: `child session create answered ${created.status}: ${body}`, model }
    }
    const createdJson = (await created.json().catch(() => null)) as { session_id?: string; sessionId?: string } | null
    const childId = createdJson?.session_id ?? createdJson?.sessionId ?? ''
    if (!childId) {
      return { sessionId: '', status: 'error', text: '', error: 'child session create returned no session_id', model }
    }
    // Publish the child id to the tool part NOW, so the UI links the real child while it works.
    input.onSession?.({ sessionId: childId, model })
    return await settleAndRead(http, childId, null, input.signal, model, opts)
  } finally {
    api.live.count -= 1
  }
}

/** The create body. Throws on a spec the API would refuse, before any session exists. */
function buildCreateBody(api: CloudSubagentApi, input: SpawnSessionInput): Record<string, unknown> {
  const named = input.agent && !CLOUD_UNMAPPABLE_AGENTS.has(input.agent) ? input.agent : undefined
  const agentName = named ?? api.parentAgent
  // A named agent brings its own prompt. A built-in or inline spec has only this one.
  const instructions = named ? '' : input.systemPrompt.trim()
  if (instructions.length > INITIAL_CONTEXT_MAX_CHARS) {
    throw new Error(`Inline agent instructions are ${instructions.length} characters; a separate subagent session takes at most ${INITIAL_CONTEXT_MAX_CHARS}.`)
  }
  // Every child, named or not, is narrowed to the parent's tools (the in-process path's `rootToolAllowed`).
  const tools = childToolAllowlist(api.toolAllowlist, input.tools)
  const invalid = (tools ?? []).filter((name) => !TOOL_NAME.test(name))
  if (invalid.length > 0) throw new Error(`Invalid tool names for a separate subagent session: ${invalid.join(', ')}.`)
  const toolsValue = tools?.join(',')
  if (toolsValue && toolsValue.length > RUNTIME_CONTEXT_STRING_MAX) {
    throw new Error(`The tool list for a separate subagent session is longer than ${RUNTIME_CONTEXT_STRING_MAX} characters.`)
  }
  return {
    initial_prompt: input.prompt,
    name: input.title,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(instructions ? { initial_context: instructions } : {}),
    runtime_context: {
      [SUBAGENT_DEPTH_KEY]: api.depth + 1,
      ...(tools ? { [SUBAGENT_TOOLS_KEY]: toolsValue ?? '' } : {}),
    },
  }
}

/** `task_id` resume: a follow-up prompt to an existing child of THIS session, then the same wait + read-back. */
async function resumeChild(
  api: CloudSubagentApi,
  http: Http,
  input: SpawnSessionInput,
  model: { providerID: string; modelID: string },
  opts: CloudSubagentOptions,
): Promise<SpawnSessionResult> {
  const childId = input.sessionId!
  const notChild = new Error(`task_id ${childId} is not a subagent session of this session`)
  let res: Response
  try {
    res = await http.fetchImpl(sessionUrl(http, childId), { headers: http.headers })
  } catch (err) {
    throw new Error(`task_id ${childId} could not be read: ${errorText(err)}`)
  }
  if (res.status === 404 || res.status === 403 || res.status === 400) throw notChild
  if (res.status !== 200) throw new Error(`task_id ${childId} could not be read: the API answered ${res.status}`)
  const row = (await res.json().catch(() => null)) as SessionRow | null
  if (!row || (api.sessionId && row.parent_session_id !== api.sessionId)) throw notChild
  if (row.working?.state === 'working') throw new Error(`task_id ${childId} is already running`)
  const baseline = row.working?.since ?? null

  if (api.live.count >= api.maxLive) {
    throw new Error(
      `At most ${api.maxLive} separate subagent sessions run at once for one session, and ${api.live.count} are running. Wait for one to return, or pass session: "same" to run this one inside this session.`,
    )
  }
  api.live.count += 1
  try {
    let sent: Response
    try {
      sent = await http.fetchImpl(sessionUrl(http, childId, '/prompts'), {
        method: 'POST',
        headers: http.headers,
        body: JSON.stringify({
          client_message_id: crypto.randomUUID(),
          parts: [{ type: 'text', text: input.prompt }],
          client_sent_at_ms: (opts.now ?? Date.now)(),
        }),
      })
    } catch (err) {
      return { sessionId: childId, status: 'error', text: '', error: `follow-up prompt failed: ${errorText(err)}`, model }
    }
    if (sent.status !== 200 && sent.status !== 202) {
      const body = (await sent.text().catch(() => '')).slice(0, 500)
      return { sessionId: childId, status: 'error', text: '', error: `follow-up prompt answered ${sent.status}: ${body}`, model }
    }
    input.onSession?.({ sessionId: childId, model })
    return await settleAndRead(http, childId, baseline, input.signal, model, opts)
  } finally {
    api.live.count -= 1
  }
}

async function settleAndRead(
  http: Http,
  childId: string,
  baseline: string | null,
  signal: AbortSignal | undefined,
  model: { providerID: string; modelID: string },
  opts: CloudSubagentOptions,
): Promise<SpawnSessionResult> {
  const settled = await waitForIdle(http, childId, baseline, signal, opts)
  if (settled.status === 'aborted') {
    // The parent gave up on the call: do not leave the child working (and billing) on its own.
    if (signal?.aborted) await stopChild(http, childId)
    return { sessionId: childId, status: 'aborted', text: '', model }
  }
  if (settled.status === 'timeout') {
    // Stop it: a child nobody waits on would keep using compute, and its freed slot would let the cap be exceeded.
    await stopChild(http, childId)
    return { sessionId: childId, status: 'error', text: '', error: `${settled.error}; the child session was stopped`, model }
  }
  if (settled.status === 'error') return { sessionId: childId, status: 'error', text: '', error: settled.error, model }
  const report = await readFinalText(http, childId)
  if (report.error) return { sessionId: childId, status: 'error', text: '', error: report.error, model }
  return { sessionId: childId, status: 'completed', text: report.text, model }
}

type Settled = { status: 'completed' | 'error' | 'aborted' | 'timeout'; error?: string }

/**
 * Poll `GET /v1/projects/:projectId/sessions/:childId` until the child's turn
 * settles: `working.state` is `idle` after it was seen working, or idle with a
 * `since` newer than `baseline` (a turn that started and ended between two
 * polls), or the lifecycle `status` is terminal.
 */
async function waitForIdle(
  http: Http,
  childId: string,
  baseline: string | null,
  signal: AbortSignal | undefined,
  opts: CloudSubagentOptions,
): Promise<Settled> {
  const now = opts.now ?? (() => Date.now())
  const ceiling = opts.waitCeilingMs ?? WAIT_CEILING_MS
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const deadline = now() + ceiling
  let everWorked = false
  for (;;) {
    if (signal?.aborted) return { status: 'aborted' }
    if (now() > deadline) return { status: 'timeout', error: `child session did not settle within ${Math.round(ceiling / 60_000)} min` }
    let res: Response
    try {
      res = await http.fetchImpl(sessionUrl(http, childId), { headers: http.headers })
    } catch (err) {
      logger.warn('[pi] cloud subagent poll failed, retrying', { childId, err: errorText(err) })
      await delay(interval, signal)
      continue
    }
    if (res.status === 200) {
      const row = (await res.json().catch(() => null)) as SessionRow | null
      if (row) {
        if (row.status === 'failed') return { status: 'error', error: 'child session failed' }
        if (row.status === 'stopped') return { status: 'aborted' }
        const working = row.working
        if (working?.state === 'working' || working?.pending_delivery) everWorked = true
        const idle = working?.state === 'idle' && !working.pending_delivery
        const newTurnEnded = idle && !!working?.since && working.since !== baseline
        if ((idle && (everWorked || newTurnEnded)) || row.status === 'completed') return { status: 'completed' }
      }
    } else if (res.status === 404) {
      return { status: 'error', error: 'child session disappeared' }
    }
    await delay(interval, signal)
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve() }
    // The listener goes when the timer fires: one wait polls up to ~900 times on the same signal.
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Best effort: `POST …/sessions/:childId/stop`. The parent box token owns the child, so it may stop it. */
async function stopChild(http: Http, childId: string): Promise<void> {
  try {
    await http.fetchImpl(sessionUrl(http, childId, '/stop'), { method: 'POST', headers: http.headers, body: '{}' })
  } catch (err) {
    logger.warn('[pi] cloud subagent stop failed', { childId, err: errorText(err) })
  }
}

interface CompactMessage {
  role?: string
  text?: string
  error?: unknown
}

/**
 * The child's final assistant report, read back through the platform
 * transcript route (`GET …/sessions/:childId/transcript?detail=full`): the
 * route project automation reads, live from the child's box or from its saved
 * mirror. `detail=full` keeps the answer whole up to 16,000 characters.
 *
 * Only the turn this call started counts: the messages after the last user
 * message (the prompt just sent). An earlier turn's report is never returned
 * as this turn's result. If the newest assistant message of the turn failed,
 * the result is an error, even when an earlier message of the turn has text.
 */
async function readFinalText(http: Http, childId: string): Promise<{ text: string; error?: string }> {
  const pointer = `The subagent ran as the Kortix child session ${childId}; its transcript is that session.`
  let res: Response
  try {
    res = await http.fetchImpl(sessionUrl(http, childId, `/transcript?limit=${READ_BACK_MESSAGES}&detail=full`), { headers: http.headers })
  } catch (err) {
    logger.warn('[pi] cloud subagent read-back failed', { childId, err: errorText(err) })
    return { text: `${pointer} Its final report could not be read back: ${errorText(err)}.` }
  }
  if (res.status !== 200) return { text: `${pointer} Its final report could not be read back: the API answered ${res.status}.` }
  const body = (await res.json().catch(() => null)) as { messages?: CompactMessage[] } | null
  const messages = body?.messages ?? []
  // No user message in the window: the turn is longer than the window, so the whole window is this turn.
  const turn = messages.slice(messages.findLastIndex((m) => m.role === 'user') + 1)
  const assistants = turn.filter((m) => m.role === 'assistant')
  const last = assistants.at(-1)
  if (last?.error) return { text: '', error: `the subagent's last turn failed: ${errorText(last.error)}` }
  const report = [...assistants].reverse().find((m) => typeof m.text === 'string' && m.text.trim())
  if (report) return { text: report.text!.trim() }
  return { text: `${pointer} It finished without a text report.` }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    const message = data?.message ?? record.message ?? record.name
    if (typeof message === 'string') return message
    return JSON.stringify(err).slice(0, 300)
  }
  return String(err)
}
