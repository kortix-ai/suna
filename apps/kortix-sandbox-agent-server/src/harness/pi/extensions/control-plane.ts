/**
 * The Kortix API as the multi-agent tools reach it (`messaging.ts`,
 * `team-tasks.ts`): the same control plane and the same session token the
 * separate-session spawn uses (`../cloud-subagent.ts`). The token is bound to
 * this session, so every call acts as this session for its person: the API
 * refuses what that person may not do, and the refusal is a result.
 */
import type { KortixCardRow, KortixToolCard, KortixToolError } from '@kortix/api-contract/kortix-tool-card'
import type { SessionBoardState } from '@kortix/api-contract/multi-agent'

/** Where this session's tools reach the API, or null without a control plane. */
export interface ControlPlane {
  /** `KORTIX_API_URL`, with or without the `/v1` suffix. */
  apiUrl: string
  projectId: string
  /** The session's sandbox token (`KORTIX_TOKEN`). */
  token: string
  /** This session's id (`KORTIX_SESSION_ID`). */
  sessionId: string
}

export interface ApiAnswer {
  status: number
  /** The JSON body, or null when it was not JSON. */
  body: unknown
}

/**
 * The longest one call may take. No multi-agent tool waits on another
 * session: the API answers each from its own state (a message is queued for
 * delivery, a watch is recorded), so a normal answer takes well under 2 s and
 * this only bounds a hung network.
 */
export const CONTROL_PLANE_CALL_TIMEOUT_MS = 10_000

/** One JSON call. A network failure or the timeout throws; any HTTP status is an answer. */
export async function callApi(plane: ControlPlane, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<ApiAnswer> {
  const origin = plane.apiUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  const timeout = AbortSignal.timeout(CONTROL_PLANE_CALL_TIMEOUT_MS)
  const res = await fetch(`${origin}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${plane.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const text = await res.text().catch(() => '')
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

/** `/projects/:id/sessions/:sid` with both ids encoded. */
export function sessionPath(projectId: string, sessionId: string, suffix = ''): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}${suffix}`
}

/** The tools whose result is a card (`KortixToolResult` with one of these names). */
export type MultiAgentToolName = 'send_message' | 'list_agents' | 'task_create' | 'task_list' | 'task_get' | 'task_update' | 'task_stop'

/**
 * `KortixToolResult` (`@kortix/api-contract/kortix-tool-card`) for a
 * multi-agent tool: the same `{ ok, tool, action, card, data?, error? }`
 * document, named by one of these tools. The tool's whole text output is this
 * object as JSON; the web client renders `card`.
 */
export interface MultiAgentToolResult {
  ok: boolean
  tool: MultiAgentToolName
  action: string
  card: KortixToolCard
  data?: unknown
  error?: KortixToolError
}

/** The pi tool return of a result: the JSON text for the model, the document as `details`. */
export function toolReturn(result: MultiAgentToolResult): { content: Array<{ type: 'text'; text: string }>; details: MultiAgentToolResult } {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
}

/** The error message an API refusal body carries, else a generic line. */
export function apiErrorMessage(answer: ApiAnswer, what: string): string {
  const body = answer.body as { error?: unknown; message?: unknown; detail?: unknown } | null
  const text = [body?.message, body?.error, body?.detail].find((value) => typeof value === 'string' && value.trim())
  return typeof text === 'string' ? text : `${what}: the Kortix API answered ${answer.status}.`
}

/** The error kind of an HTTP status. */
export function errorKind(status: number): KortixToolError['kind'] {
  if (status === 401 || status === 403) return 'denied'
  if (status === 404) return 'not_found'
  if (status === 400 || status === 409 || status === 422) return 'invalid'
  return 'failed'
}

/** A failed call as a result: the card says what did not happen, in plain words. */
export function failure(tool: MultiAgentToolName, action: string, title: string, error: KortixToolError, rows?: KortixCardRow[]): MultiAgentToolResult {
  return {
    ok: false,
    tool,
    action,
    card: { title, subtitle: error.message, status: error.kind === 'denied' ? 'denied' : 'error', ...(rows?.length ? { rows } : {}) },
    error,
  }
}

/** A board state as the badge a person reads. */
export const BOARD_STATE_BADGE: Record<SessionBoardState, string> = {
  working: 'working',
  needs_input: 'needs you',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
}
