/**
 * The transport for every session-lifecycle call to a session's runtime — the
 * one place the runtime headers and the bounded timeout live. Each caller
 * resolves the session's signed proxy endpoint and maps outcomes itself; only
 * the request prefix is shared. A transport failure throws, so a caller's
 * fail-open default and the warning that explains it stay at the call site.
 */

import { RUNTIME_ACTIONS_CAPABILITY, RUNTIME_LOG_CAPABILITY } from '@kortix/api-contract/runtime-relay';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

/** The directory every runtime read and write is forwarded under. */
export const WORKSPACE = '/workspace';

/** A session whose signed runtime endpoint is resolved. */
export interface ResolvedSessionRuntime {
  endpoint: { url: string; headers: Record<string, string> };
  opencodeSessionId: string;
  externalId?: string;
}

/**
 * Send one signed request to a resolved session runtime. `path` is the part
 * after the endpoint URL, query included. A non-2xx stays a `Response` for the
 * caller to map.
 */
export function sessionRuntimeFetch(
  endpoint: { url: string; headers: Record<string, string> },
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {},
  timeoutMs = 5_000,
): Promise<Response> {
  return fetch(`${endpoint.url}${path}`, {
    method,
    headers: sandboxRuntimeRequestHeaders({ ...endpoint.headers, ...init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const segment = encodeURIComponent;

/** The Kortix turn routes (`routes/kortix/runtime.ts` in kortixd). */
export const runtimeVerbPaths = {
  messages: (sessionId: string, opts: { limit: number; before?: string | null }) =>
    `/kortix/runtime/messages/${segment(sessionId)}?limit=${opts.limit}${opts.before ? `&before=${segment(opts.before)}` : ''}`,
  message: (sessionId: string, messageId: string) =>
    `/kortix/runtime/messages/${segment(sessionId)}/${segment(messageId)}`,
  /** Take back a user message no model call has read (`runtime.retract.v1`). */
  retract: (sessionId: string, messageId: string) =>
    `/kortix/runtime/messages/${segment(sessionId)}/${segment(messageId)}/retract`,
  abort: (sessionId: string) => `/kortix/runtime/sessions/${segment(sessionId)}/abort`,
  agents: (directory: string) => `/kortix/runtime/agents?directory=${segment(directory)}`,
  prompt: (sessionId: string) => `/kortix/runtime/sessions/${segment(sessionId)}/prompt`,
  /** Hand a message to the RUNNING turn (`session.steer`). Not a turn start. */
  steer: (sessionId: string) => `/kortix/runtime/sessions/${segment(sessionId)}/steer`,
  /** The session-log actions (`runtime.actions.v1`). */
  questionReply: (requestId: string) => `/kortix/runtime/questions/${segment(requestId)}/reply`,
  /** The box's own session log (`runtime.log.v1`): a page of the root, newest `limit` before `before_seq`. */
  log: (opts: { limit: number; beforeSeq?: number | null }) =>
    `/kortix/runtime/log?limit=${opts.limit}${opts.beforeSeq != null ? `&before_seq=${opts.beforeSeq}` : ''}`,
  logMessage: (messageId: string) => `/kortix/runtime/log/messages/${segment(messageId)}`,
} as const;

const CAPABILITIES_TTL_MS = 5 * 60_000;
const CAPABILITIES_MEMO_MAX = 5_000;
// ponytail: per-process memo, cleared when full; a box whose daemon updates in
// place is read again after the TTL.
const capabilitiesMemo = new Map<string, { capabilities: string[]; at: number }>();

/**
 * What this sandbox's runtime serves: the `capabilities` of `/kortix/health`.
 * One read per sandbox per 5 minutes. Null when the read fails, and a failed
 * read is not kept. A daemon that lists nothing answers `[]`.
 *
 * `/start` returns the list with `stage: ready`, so a client knows what the
 * runtime serves before its own first health probe answers.
 */
export async function runtimeCapabilities(
  externalId: string | undefined,
  endpoint: () => Promise<{ url: string; headers: Record<string, string> } | null>,
  now = Date.now(),
): Promise<string[] | null> {
  if (!externalId) return null;
  const known = capabilitiesMemo.get(externalId);
  if (known && now - known.at < CAPABILITIES_TTL_MS) return known.capabilities;
  try {
    const resolved = await endpoint();
    if (!resolved) return null;
    const res = await sessionRuntimeFetch(resolved, 'GET', '/kortix/health');
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { capabilities?: unknown } | null;
    const capabilities = Array.isArray(body?.capabilities)
      ? body.capabilities.filter((value): value is string => typeof value === 'string')
      : [];
    if (capabilitiesMemo.size >= CAPABILITIES_MEMO_MAX) capabilitiesMemo.clear();
    capabilitiesMemo.set(externalId, { capabilities, at: now });
    return capabilities;
  } catch {
    return null;
  }
}

/**
 * Does this sandbox's daemon serve the session-log actions (`runtime.actions.v1`)?
 * A failed read answers false: the caller uses the route every daemon serves.
 */
export async function runtimeServesActions(
  externalId: string | undefined,
  endpoint: () => Promise<{ url: string; headers: Record<string, string> } | null>,
): Promise<boolean> {
  return (await runtimeCapabilities(externalId, endpoint))?.includes(RUNTIME_ACTIONS_CAPABILITY) ?? false;
}

/**
 * Does the box serve its own session log (`runtime.log.v1`): whole pages, and a prompt in the log
 * from its admission? Then the log is the transcript the API reads. Same memo as above.
 */
export async function runtimeServesLog(
  externalId: string | undefined,
  endpoint: () => Promise<{ url: string; headers: Record<string, string> } | null>,
): Promise<boolean> {
  return (await runtimeCapabilities(externalId, endpoint))?.includes(RUNTIME_LOG_CAPABILITY) ?? false;
}

/** Test-only. */
export function __resetRuntimeCapabilitiesMemo(): void {
  capabilitiesMemo.clear();
}
