/**
 * Bounded auth submits.
 *
 * The auth page used to call its server actions directly. A hung POST then
 * had two consequences the visitor could not escape: the submit button stayed
 * disabled forever, and a retry click queued behind the hung action in Next's
 * serial client action queue — the reported "sign-up submit hangs, nothing
 * recovers" failure. The submits now go through plain POST route handlers
 * (app/(system)/api/auth/*) with three bounds, each strictly inside the next
 * so the deepest one fires first and the visitor always sees a real error:
 *
 *   - AUTH_UPSTREAM_TIMEOUT_MS: each action bounds its GoTrue await, so the
 *     action itself always answers;
 *   - AUTH_ROUTE_TIMEOUT_MS: each route handler bounds the action call, so
 *     the client deadline sees a JSON error instead of a dead socket;
 *   - AUTH_SUBMIT_TIMEOUT_MS: the browser aborts the fetch and the page
 *     shows a retryable error.
 */

import { AuthApiError } from '@supabase/supabase-js';

/** Bound on every GoTrue await inside the auth actions. */
export const AUTH_UPSTREAM_TIMEOUT_MS = 20_000;
/** Bound on the action call inside each /api/auth/* route handler. */
export const AUTH_ROUTE_TIMEOUT_MS = 25_000;
/** Browser deadline for the auth page's submit fetches. */
export const AUTH_SUBMIT_TIMEOUT_MS = 30_000;

/** Shown when the submit is aborted at the browser deadline. */
export const AUTH_TIMEOUT_MESSAGE = 'This is taking longer than expected. Please try again.';
/** Shown when the request could not be delivered or the answer was unusable. */
export const AUTH_NETWORK_MESSAGE = 'The request could not be sent. Please try again.';
/** Shown when the server action threw unexpectedly. */
export const AUTH_UNEXPECTED_MESSAGE = 'Something went wrong. Please try again.';

/**
 * The error a bounded GoTrue await resolves with when the deadline fires: a
 * real AuthApiError so every downstream check (code, message, status) sees
 * the shape it expects. Shared instance — the error carries no per-request
 * state and is never mutated.
 */
export const AUTH_TIMEOUT_AUTH_ERROR = new AuthApiError(AUTH_TIMEOUT_MESSAGE, 503, 'timeout');

/**
 * Same-origin enforcement for the /api/auth/* route handlers. Server actions
 * got Next's CSRF check for free; a route handler must do its own. A browser
 * POST always carries an Origin header, and it must match the host the request
 * arrived on (x-forwarded-host when a proxy rewrote it).
 */
export function sameOriginRequest(req: {
  headers: { get(name: string): string | null };
}): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  return Boolean(host) && originHost === host;
}

export type AuthSubmitFailureReason = 'timeout' | 'network' | 'server';

export type AuthSubmitOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: AuthSubmitFailureReason; message: string };

/**
 * Resolve with `fallback` when `p` does not settle within `ms`. The loser's
 * late rejection is swallowed so a timeout can never surface later as an
 * unhandled rejection. `F` is the deadline's failure shape — usually narrower
 * than the awaited result (a `{ message }` or `{ error }` the caller already
 * handles), so the resolved type is the union.
 */
export async function settleWithin<P, F = P>(
  p: Promise<P>,
  ms: number,
  fallback: () => F,
): Promise<P | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<P | F>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
    p.catch(() => {});
  }
}

/**
 * POST the auth form to its bounded route handler and map every failure mode
 * to a retryable outcome. Never throws. The deadline is a parameter so tests
 * can pin the abort behavior in milliseconds.
 */
export async function submitAuthForm(
  path: string,
  body: FormData,
  timeoutMs: number = AUTH_SUBMIT_TIMEOUT_MS,
): Promise<AuthSubmitOutcome> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json) {
      const message = json && typeof json.message === 'string' ? json.message : AUTH_NETWORK_MESSAGE;
      return { ok: false, reason: 'server', message };
    }
    return { ok: true, result: json };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return aborted
      ? { ok: false, reason: 'timeout', message: AUTH_TIMEOUT_MESSAGE }
      : { ok: false, reason: 'network', message: AUTH_NETWORK_MESSAGE };
  }
}
