/**
 * One connection of a long-lived Kortix SSE stream, with the platform auth.
 *
 * The host's `eventStreamTransport` with the platform auth headers, or the
 * streaming `authenticatedFetch` without a deadline: the caller's signal and
 * its own liveness watchdog end the connection, never a request timeout. Read
 * from the platform config on every connection. Used by the runtime event
 * stream (`core/runtime/client.ts`) and the session control stream
 * (`core/session/control-stream.ts`).
 */

import { authenticatedFetch } from '../http/auth';
import { platformConfig } from '../http/config';
import { platformRequestHeaders } from '../http/transport';
import { fetchEventTransport, type RuntimeEventTransport } from '../runtime/runtime-rest-client';

export const platformEventTransport: RuntimeEventTransport = async function* (request) {
  const custom = platformConfig().eventStreamTransport;
  if (!custom) {
    yield* fetchEventTransport(((input: RequestInfo | URL, init?: RequestInit) =>
      authenticatedFetch(input, init, { timeoutMs: null })) as typeof fetch)(request);
    return;
  }
  const { headers, rejected } = await platformRequestHeaders(request.url, request.headers);
  try {
    yield* custom({ ...request, headers });
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 401) rejected();
    throw error;
  }
};
