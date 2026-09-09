/**
 * WHEN A 5xx FROM A SANDBOX IS AN ANSWER, NOT A PORT THAT IS DOWN.
 *
 * The proxy retries 502/503 four times with backoff, because a 5xx from a
 * preview normally means the container is up and the port is not yet listening.
 * That is right for a booting daemon and wrong for an agent that answered.
 *
 * A cell refuses a request that names no session — the web client's in-box
 * calls carry none — and it will refuse the next three identically. Measured on
 * dev 2026-09-09 against a real user's box, the cell answered in 43-85 ms and
 * the browser waited four and a half SECONDS:
 *
 *   GET  /v1/p/<box>/8000/question         503 4645ms  upstream_ms 52
 *   POST /v1/p/<box>/8000/log              503 4722ms  upstream_ms 85
 *   GET  /v1/p/<box>/8000/permission       503 4739ms  upstream_ms 43
 *   GET  /v1/p/<box>/8000/lsp/diagnostics  503 4454ms  upstream_ms 48
 *
 * About ten such calls back a single session view, so the retries alone cost
 * tens of seconds — which is what a user reports as the session never loading.
 *
 * The upstream says so itself rather than the proxy guessing from a body: a
 * response carrying `x-kortix-final` was produced by the agent deliberately.
 * Anything without it keeps the old behaviour exactly, so a genuinely cold port
 * still gets its four attempts.
 */
export const UPSTREAM_FINAL_HEADER = 'x-kortix-final';

export function upstreamAnsweredFinally(headers: Headers | null | undefined): boolean {
  if (!headers) return false;
  const v = headers.get(UPSTREAM_FINAL_HEADER);
  return typeof v === 'string' && v.trim() !== '' && v.trim() !== '0';
}
