/**
 * The session-log actions a box serves under `/kortix/runtime` when its health
 * lists `runtime.actions.v1`: answers to permission requests and questions,
 * compaction, commands, grants, the pending requests and the workspace. The
 * verbs and hooks use them on such a box, and the runtime's compatibility
 * routes on an older one.
 */

import { ApiError } from '../http/api/errors';
import { authenticatedFetch } from '../http/auth';
import type { SessionLogMessage } from '../session-log/types';
import { getActiveRuntimeUrl } from './server-store/active';

/** The health capability of a box that serves the session-log actions. */
export const RUNTIME_ACTIONS_CAPABILITY = 'runtime.actions.v1';

/** What a thread does now; a retry reads as `busy`. */
export type RuntimeThreadStatus = 'idle' | 'busy' | 'compacting';

/** One request the runtime waits on: a permission request or a question. */
export interface RuntimePendingRecord {
  id: string;
  /** The thread (the root or a subagent child) that asked. */
  thread_id: string;
  /** The tool call that waits on the answer. */
  call_id?: string;
  /** A permission: `{ permission, patterns, always, metadata }`. A question: `{ questions }`. */
  payload: unknown;
  /** When the runtime asked (ISO 8601); `''` when an older runtime does not say. */
  asked_at: string;
}

/** Each thread's status and the requests that wait on a person. */
export interface RuntimePending {
  statuses: Record<string, RuntimeThreadStatus>;
  permissions: RuntimePendingRecord[];
  questions: RuntimePendingRecord[];
}

/** One page of a thread of the box's own session log (`GET /kortix/runtime/log`). */
export interface RuntimeLogPage {
  generation?: number;
  thread_id: string;
  /** Ascending `seq`; the running turn's reply is a `streaming` message. */
  messages: SessionLogMessage[];
  /** Older messages exist: ask again with `before_seq` = the first message's `seq`. */
  has_more: boolean;
}

/** Where the session's checkout is (`GET /kortix/runtime/workspace`). */
export interface RuntimeWorkspaceInfo {
  directory: string;
  home: string;
  vcs: 'git' | null;
  /** The repository's default branch; null when unknown. */
  default_branch: string | null;
}

/** One changed file of the checkout (`GET /kortix/runtime/workspace/diff`). */
export interface RuntimeWorkspaceFileDiff {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  patch?: string;
}

const segment = encodeURIComponent;

/** The action routes, relative to the session's runtime URL. */
export const runtimeActionPaths = {
  permissionReply: (requestId: string) => `/kortix/runtime/permissions/${segment(requestId)}/reply`,
  questionReply: (requestId: string) => `/kortix/runtime/questions/${segment(requestId)}/reply`,
  questionReject: (requestId: string) => `/kortix/runtime/questions/${segment(requestId)}/reject`,
  abort: (runtimeSessionId: string) => `/kortix/runtime/sessions/${segment(runtimeSessionId)}/abort`,
  compact: (runtimeSessionId: string) => `/kortix/runtime/sessions/${segment(runtimeSessionId)}/compact`,
  command: (runtimeSessionId: string) => `/kortix/runtime/sessions/${segment(runtimeSessionId)}/command`,
  grants: (runtimeSessionId: string) => `/kortix/runtime/sessions/${segment(runtimeSessionId)}/grants`,
  commands: '/kortix/runtime/commands',
  pending: '/kortix/runtime/pending',
  workspace: '/kortix/runtime/workspace',
  workspaceDiff: (mode: 'branch' | 'git') => `/kortix/runtime/workspace/diff?mode=${mode}`,
} as const;

const CAPABILITY_TTL_MS = 5 * 60_000;
const CAPABILITY_MEMO_MAX = 256;
const served = new Map<string, { served: boolean; at: number }>();

/**
 * Does the box behind `runtimeUrl` serve the session-log actions? One
 * `/kortix/health` read per runtime URL per 5 minutes; a failed read answers
 * false and is not kept, so the compatibility routes serve until a read answers.
 */
export async function runtimeServesActions(
  runtimeUrl: string,
  fetch: typeof globalThis.fetch,
  now = Date.now(),
): Promise<boolean> {
  const base = runtimeUrl.replace(/\/$/, '');
  const known = served.get(base);
  if (known && now - known.at < CAPABILITY_TTL_MS) return known.served;
  try {
    const response = await fetch(new Request(`${base}/kortix/health`, { method: 'GET' }));
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { capabilities?: unknown } | null;
    const answer = Array.isArray(body?.capabilities) && body.capabilities.includes(RUNTIME_ACTIONS_CAPABILITY);
    if (served.size >= CAPABILITY_MEMO_MAX) served.clear();
    served.set(base, { served: answer, at: now });
    return answer;
  } catch {
    return false;
  }
}

/**
 * One action-route request to the ACTIVE session's runtime, as the signed-in
 * user. Null when no runtime is active or its box does not serve the actions:
 * the caller then uses the compatibility client.
 */
export async function activeRuntimeAction(method: string, path: string, body?: unknown): Promise<Response | null> {
  const runtimeUrl = getActiveRuntimeUrl().replace(/\/$/, '');
  const fetch = authenticatedFetch as typeof globalThis.fetch;
  if (!runtimeUrl || !(await runtimeServesActions(runtimeUrl, fetch))) return null;
  return fetch(
    new Request(`${runtimeUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );
}

/** An `ApiError` that carries the action route's own message and status. */
export async function runtimeActionError(response: Response, what: string): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let detail = text || `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (typeof parsed.message === 'string') detail = parsed.message;
  } catch {
    // Not JSON: the text is the message.
  }
  return new ApiError(`${what}: ${detail}`, { status: response.status, response });
}

/** Test-only. */
export function __resetRuntimeActionsMemo(): void {
  served.clear();
}
