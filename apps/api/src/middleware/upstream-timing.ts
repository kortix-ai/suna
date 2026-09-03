/**
 * Split a request's wall time into "what the API did" and "what it waited on".
 *
 * ─── Why (2026-08-26) ───────────────────────────────────────────────────────
 * A session open spends ~1.7 s on `GET /v1/p/<ext>/8000/agent` and ~1.9 s on
 * `/sessions/:id/config`, and from OUTSIDE the box there is no way to tell how
 * much of that is the API and how much is the sandbox hop it is proxying: a HAR
 * sees one number. The measurement pass that found those figures could not
 * split them, so every proposed fix was a guess about which side to attack.
 *
 * This closes that gap with one standard header:
 *
 *   Server-Timing: up;dur=1503, api;dur=41
 *
 * `up` is the summed time inside the upstream calls the handler made (the
 * sandbox daemon fetch, a provider API call); `api` is the remainder — auth,
 * database reads, serialization, this API's own work. Browsers surface it in
 * the network panel and it survives into a HAR, so the next attribution pass
 * reads the answer instead of inferring it.
 *
 * A handler opts in by calling `recordUpstreamMs()` around whatever it waits
 * on. Calls ACCUMULATE, so a retried fetch or several upstream calls in one
 * request add up rather than the last one winning. A handler that records
 * nothing gets a plain `api;dur=` line, which is still the honest answer for a
 * route that waits on nothing.
 */

import type { Context, Next } from 'hono';
import { getRequestContext, setContextField } from '../lib/request-context';

/** Context field the accumulated upstream time is carried on. */
export const UPSTREAM_MS_FIELD = 'upstream_ms';

/**
 * Add `ms` to this request's upstream total. No-op outside a request scope
 * (background sweeps, unit tests with no context), so a call site never has to
 * guard.
 */
export function recordUpstreamMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const ctx = getRequestContext();
  if (!ctx) return;
  const current = Number(ctx[UPSTREAM_MS_FIELD] ?? 0);
  setContextField(
    UPSTREAM_MS_FIELD,
    String(Math.round((Number.isFinite(current) ? current : 0) + ms)),
  );
}

/**
 * Time `fn` and attribute it to upstream. Records even when `fn` throws — a
 * slow FAILING upstream is exactly the case worth attributing.
 */
export async function timeUpstream<T>(fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordUpstreamMs(performance.now() - start);
  }
}

/** Read this request's accumulated upstream time, in whole milliseconds. */
export function upstreamMsSoFar(): number {
  const ctx = getRequestContext();
  const value = Number(ctx?.[UPSTREAM_MS_FIELD] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** Split independently measured clocks into valid whole-millisecond values. */
export function splitTimingDurations(
  totalMs: number,
  upstreamMs: number,
): { upstream: number; api: number } {
  const upstream = Math.round(upstreamMs);
  return {
    upstream,
    api: Math.max(0, Math.round(totalMs - upstreamMs)),
  };
}

/**
 * Emit `Server-Timing` on every response. Mount globally, INSIDE the request
 * context middleware (it reads the context the latter creates).
 */
export async function upstreamTiming(c: Context, next: Next): Promise<void> {
  const start = performance.now();
  await next();

  const total = performance.now() - start;
  const durations = splitTimingDurations(total, upstreamMsSoFar());
  // `api` is the remainder, floored at zero: the two clocks are started at
  // different depths of the chain, so rounding can otherwise produce a
  // nonsensical negative on a request that is almost entirely one upstream call.
  c.header(
    'Server-Timing',
    durations.upstream > 0
      ? `up;dur=${durations.upstream}, api;dur=${durations.api}`
      : `api;dur=${durations.api}`,
  );
}
