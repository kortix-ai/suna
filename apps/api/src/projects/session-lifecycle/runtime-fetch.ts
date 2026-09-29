/**
 * The transport for every session-lifecycle call to a session's runtime — the
 * one place the runtime headers and the bounded timeout live. Each caller
 * resolves the session's signed proxy endpoint and maps outcomes itself; only
 * the request prefix is shared. A transport failure throws, so a caller's
 * fail-open default and the warning that explains it stay at the call site.
 */

import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';

/** The directory every runtime read and write is forwarded under. */
export const WORKSPACE = '/workspace';

/** A session whose signed runtime endpoint is resolved. */
export interface ResolvedSessionRuntime {
  endpoint: { url: string; headers: Record<string, string> };
  opencodeSessionId: string;
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
