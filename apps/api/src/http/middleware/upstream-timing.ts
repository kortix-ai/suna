/**
 * The Server-Timing middleware: `up` (upstream) and `api` (the rest). The
 * accumulator it reads lives in lib/upstream-timing.ts.
 */

import type { Context, Next } from 'hono';
import { formatStageEntries, formatTurnStageEntries, stageSnapshot } from '../../lib/server-timing';
import { upstreamMsSoFar } from '../../lib/upstream-timing';

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
  //
  // `total` plus the per-stage entries (auth, gotrue, iam, db, git, http — see
  // lib/server-timing.ts) break the same wall time down by layer. Stages
  // overlap each other and `api`; each is its own wall time, not a share.
  const entries = [
    `total;dur=${Math.round(total)}`,
    ...formatStageEntries(stageSnapshot()),
    ...(durations.upstream > 0 ? [`up;dur=${durations.upstream}`] : []),
    `api;dur=${durations.api}`,
    // The turn-latency spec (PR #7840) §5: present only on a promptDelivery turn
    // (see recordTurnStageMarks's one caller, services/sandbox-proxy/forward/upstream.ts)
    // — empty, and therefore invisible, on every other request.
    ...formatTurnStageEntries(),
  ];
  c.header('Server-Timing', entries.join(', '));
}
