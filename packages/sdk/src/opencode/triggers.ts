/**
 * Sandbox triggers client — the daemon `/kortix/triggers...` endpoints, owned
 * by the SDK. The host resolves which sandbox base URL to talk to (it may
 * differ from the globally active runtime — e.g. a specific trigger's owning
 * sandbox, or a freshly-provisioned default sandbox) and calls through here
 * instead of `authenticatedFetch('/kortix/triggers...')` directly.
 *
 * The trigger payload/response shapes are host-defined (cron/webhook trigger
 * CRUD, executions) rather than part of the OpenCode protocol, so this stays a
 * thin typed passthrough rather than a full typed surface per endpoint.
 */
import { authenticatedFetch } from '../platform/auth';

/**
 * JSON request against `${baseUrl}/kortix/triggers${path}`, surfacing the
 * daemon's error body on non-2xx responses.
 */
export async function triggersRequest<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await authenticatedFetch(`${baseUrl.replace(/\/+$/, '')}/kortix/triggers${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error || body?.message || `Request failed with ${response.status}`);
  }
  return body as T;
}
