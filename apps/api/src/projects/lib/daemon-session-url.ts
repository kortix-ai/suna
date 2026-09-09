/**
 * WHICH SESSION A DAEMON CALL IS ABOUT, on a box that holds several.
 *
 * `fetchRuntimeState` and `openRuntimeEventStream` address a BOX — the URL is
 * `resolveSandboxIngress(externalId)` and nothing in it names a session. That
 * was the same question while a box held one session. A CELL SANDBOX HOLDS
 * MANY, one isolate each, and the cell worker picks which one from `?c=`.
 *
 * With no session anywhere in the request the worker had nothing to pick, so
 * the two calls the UI depends on never reached a session's isolate at all.
 * Measured on dev 2026-09-09, watching the stream the frontend opens for 75 s
 * across a full answer:
 *
 *   959 ms   kortix.runtime.status {"state":"down","reason":"daemon_503"}
 *   then     control frames and heartbeats only, runtime_seq null throughout
 *   never    one runtime content frame
 *
 * `?c=` rather than a path prefix, and for EVERY runtime rather than only for
 * cells: this is a direct server-to-server call to the sandbox's own origin,
 * not through the `/v1/p/` proxy that drops query strings, and a daemon
 * ignores a parameter it does not read. The same reasoning `envPushUrl`
 * already runs on, so the two addressings cannot drift apart.
 */
export function daemonSessionUrl(
  base: string,
  path: string,
  sessionId: string | null | undefined,
  params: Record<string, string | number | null | undefined> = {},
): string {
  const url = new URL(`${String(base ?? '').replace(/\/+$/, '')}${path}`);
  const id = sessionId?.trim();
  if (id) url.searchParams.set('c', id);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
