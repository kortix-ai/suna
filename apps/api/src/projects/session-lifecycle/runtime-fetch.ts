/**
 * The transport for every session-lifecycle call to a session's runtime — the
 * one place the runtime headers and the bounded timeout live. Each caller
 * resolves the session's signed proxy endpoint and maps outcomes itself; only
 * the request prefix is shared. A transport failure throws, so a caller's
 * fail-open default and the warning that explains it stay at the call site.
 */

import { RUNTIME_TURNS_CAPABILITY } from '@kortix/api-contract/runtime-relay';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

/** The directory every runtime read and write is forwarded under. */
export const WORKSPACE = '/workspace';

/** A session whose signed runtime endpoint is resolved. */
export interface ResolvedSessionRuntime {
  endpoint: { url: string; headers: Record<string, string> };
  opencodeSessionId: string;
  /** The sandbox, for `runtimeServesTurnVerbs`. */
  externalId?: string;
}

/**
 * Send one signed request to a resolved session runtime. `path` is the part
 * after the endpoint URL and already carries `?directory=…`. A non-2xx stays a
 * `Response` for the caller to map.
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
  abort: (sessionId: string) => `/kortix/runtime/sessions/${segment(sessionId)}/abort`,
  agents: (directory: string) => `/kortix/runtime/agents?directory=${segment(directory)}`,
  prompt: (sessionId: string) => `/kortix/runtime/sessions/${segment(sessionId)}/prompt`,
  state: '/kortix/runtime/state',
} as const;

const TURN_VERBS_TTL_MS = 5 * 60_000;
const TURN_VERBS_MEMO_MAX = 5_000;
// ponytail: per-process memo, cleared when full; a box whose daemon updates in
// place is read again after the TTL.
const turnVerbs = new Map<string, { serves: boolean; at: number }>();

/**
 * Does this sandbox's daemon serve the Kortix turn routes (`runtime.turns.v1`
 * in `/kortix/health` `capabilities`)? One read per sandbox per 5 minutes. A
 * failed read answers false and is not kept: the legacy spelling works on
 * every daemon, so a miss costs only the old path.
 */
export async function runtimeServesTurnVerbs(
  externalId: string | undefined,
  endpoint: () => Promise<{ url: string; headers: Record<string, string> } | null>,
  now = Date.now(),
): Promise<boolean> {
  if (!externalId) return false;
  const known = turnVerbs.get(externalId);
  if (known && now - known.at < TURN_VERBS_TTL_MS) return known.serves;
  try {
    const resolved = await endpoint();
    if (!resolved) return false;
    const res = await sessionRuntimeFetch(resolved, 'GET', '/kortix/health');
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { capabilities?: unknown } | null;
    const serves = Array.isArray(body?.capabilities) && body.capabilities.includes(RUNTIME_TURNS_CAPABILITY);
    if (turnVerbs.size >= TURN_VERBS_MEMO_MAX) turnVerbs.clear();
    turnVerbs.set(externalId, { serves, at: now });
    return serves;
  } catch {
    return false;
  }
}

/** The header kortixd sets on every answer of a Kortix turn verb (`routes/kortix/runtime.ts`). */
export const TURN_VERB_HEADER = 'x-kortix-turn-verb';

/**
 * A Kortix-route answer from a daemon that does not have the route: a 404
 * without {@link TURN_VERB_HEADER}, from a daemon rolled back in place past
 * the memo. Forgets the sandbox's capability, so the caller resends on the
 * legacy route and the next request reads `/kortix/health` again. A 404 the
 * verb itself answered (the message is gone) carries the header and counts.
 */
export function turnVerbMissing(externalId: string | undefined, res: Response): boolean {
  if (res.status !== 404 || res.headers.get(TURN_VERB_HEADER)) return false;
  if (externalId) turnVerbs.delete(externalId);
  return true;
}

/** Test-only. */
export function __resetRuntimeTurnVerbsMemo(): void {
  turnVerbs.clear();
}
