import type { Context, Next } from 'hono';
import { setContextField } from '../lib/request-context';

// Per-sandbox in-flight count for the proxied routes, stamped on the request
// log line as `sandbox_inflight`.
//
// ─── Why (KRTX-471) ─────────────────────────────────────────────────────────
// This issue's latency shape was twice a HERD, not a slow route: 2026-10-10
// one web client fired 649 concurrent `GET /file/raw` at one box; 2026-10-16
// six concurrent reads to one degraded sandbox carried the route's p95 to
// 5.4 s while every row answered 200. From the request log those read as six
// unrelated slow requests — the concurrency had to be rebuilt by hand from
// completion timestamps. PR #9516 bounded the WEB client's fan-out (an 8-slot
// read limiter in @kortix/sdk), but agents, scripts and mobile never pass
// through it: the API is the only vantage point that sees every client's
// per-sandbox concurrency.
//
// The gate counts proxied requests in flight per sandbox (replica-local, so
// the number is a floor on a multi-replica deployment — good enough to
// attribute a herd) and stamps the value at ENTRY, counted with self:
// "1" = this request is alone; "6" = it is the sixth concurrent request to
// this sandbox. Stamping at entry (not completion) keeps the semantic stable
// and free of logger-ordering races. A herd is then one query:
// `max(sandbox_inflight) GROUP BY sandbox, minute`.
//
// Cost: one Map get/set per proxied request, an entry per ACTIVE sandbox
// (removed at zero). No awaited work, no lock, no data path change.
//
// replica-local: a herd is per-replica by construction (each replica counts
// its own in-flight requests), and the floor is fine for attribution — the
// burst rows this issue chased were all on one replica.
const inflight = new Map<string, number>();

export function sandboxInflightGate(c: Context, next: Next): Promise<void> {
  const sandboxId = c.req.param('sandboxId');
  // A CORS preflight passes combinedAuth without a credential and never
  // reaches the box; counting it would add noise to the herd signal.
  if (!sandboxId || c.req.method === 'OPTIONS') return next();
  const current = (inflight.get(sandboxId) ?? 0) + 1;
  inflight.set(sandboxId, current);
  setContextField('sandbox_inflight', String(current));
  return next().finally(() => {
    const remaining = (inflight.get(sandboxId) ?? 1) - 1;
    if (remaining <= 0) inflight.delete(sandboxId);
    else inflight.set(sandboxId, remaining);
  });
}
