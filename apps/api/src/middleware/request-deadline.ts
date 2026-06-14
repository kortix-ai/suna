import type { Context, Next } from 'hono';
import { timeout } from 'hono/timeout';
import { HTTPException } from 'hono/http-exception';

// ─── Request deadline guard ────────────────────────────────────────────────
//
// Defense-in-depth against the fleet-wide "Request timed out after 30s" class
// of incident (2026-06-08). The real root cause was DB connection-pool
// starvation (see packages/db/src/client.ts), but a secondary failure mode is
// any handler that makes a slow downstream call (Daytona, executor, git host)
// without its own timeout: it hangs until the frontend's 30s client abort,
// holding server resources the whole time and surfacing as a confusing,
// URL-only timeout in Better Stack.
//
// This middleware bounds every *non-streaming* request to a wall-clock deadline
// comfortably under the 30s client abort and returns a clean 503 (with
// Retry-After, added by the global onError) instead of letting it hang. It is a
// net so future un-bounded slow calls degrade gracefully rather than re-firing
// the incident.
//
// SAFETY:
//  - Streaming / long-poll / proxy / WS surfaces are exempted (see below) —
//    timing those out would break SSE, the sandbox preview proxy, LLM
//    streaming, git smart-HTTP, and the tunnel. WS upgrades never reach here
//    (handled in Bun.serve's fetch before app.fetch), but we still guard on the
//    Upgrade header defensively.
//  - Fully env-tunable: REQUEST_DEADLINE_MS sets the budget; 0 disables it.
//
// DEFAULT ON (25s) since the 2026-06-12 investigation: the DB-layer fix from
// 06-08 (pool sizing + statement_timeout) did NOT stop the hangs — postgres.js
// has no acquire-queue timeout, so under sustained pool saturation requests
// queued for HOURS (06-11 saw ~1,050 requests complete with 1min–3h10m
// durations, all flushing at once when load subsided) while clients had long
// given up at their 30s abort. statement_timeout never fires in that mode
// because each individual statement is fast — it's the unbounded FIFO wait in
// front of the pool that grows. A wall-clock deadline is the only layer that
// bounds the *total* wait. Long synchronous operations (provision, session
// create/wake, deployments, migrations, webhooks) are enumerated below as
// exemptions; everything else answers a browser whose own abort fires at 30s,
// so a 25s server bound changes nothing for successful requests and turns
// eternal hangs into clean, retryable 503s.

const DEADLINE_MS = (() => {
  const raw = process.env.REQUEST_DEADLINE_MS;
  if (raw === undefined) return 25_000; // default ON — see note above
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 25_000;
})();

const ENABLED = DEADLINE_MS > 0;

// Route prefixes that stream, long-poll, proxy, or carry arbitrary upstream
// latency and therefore must not be bounded by a fixed deadline.
const EXEMPT_PREFIXES = [
  '/v1/p',        // sandbox preview proxy (SSE event stream, long-poll, ws)
  '/v1/tunnel',   // tunnel SSE (permission-requests) + ws
  '/v1/git',      // git smart-HTTP (large packfile up/download)
  '/v1/router',   // LLM gateway — streamed chat completions
  '/v1/llm',      // LLM chat completions (streamed; p99 >10s is normal)
  '/v1/executor', // connector proxy — forwards to arbitrary upstream APIs
  '/v1/webhooks', // inbound webhooks (Slack, …) — callers retry, don't truncate
  '/v1/billing/webhooks',   // Stripe webhook processing (observed >60s, legit)
  '/v1/billing/revenuecat', // RevenueCat sync — batch reconcile, legit-long
  '/v1/admin',    // operator maintenance endpoints — deliberate long ops
];

// Path fragments for streaming or legitimately long *synchronous* endpoints
// that live under otherwise-bounded prefixes (e.g. /v1/projects/:id/...).
// These either boot sandboxes, push git repos, or sweep batches — work that
// can exceed the deadline while behaving correctly. Enumerated from 7 days of
// prod duration data (2026-06-12).
const EXEMPT_FRAGMENTS = [
  '/turn-stream',
  '/turn-question',
  '/provision-stream',
  '/provision',               // managed repo create + sandbox boot
  '/wake',                    // cold sandbox resume
  '/ensure-opencode',         // in-sandbox runtime (re)start
  '/commit-push',             // host-driven git commit+push
  '/deployments',             // app deploys (build + upload)
  '/snapshots',               // sandbox template builds
  '/suna-migration',          // OG Suna → opencode migration runs
  '/legacy-migration',        // legacy VM → project migration runs
  '/sync-opencode-sessions',  // cross-sandbox session sweep (observed ~26s)
  '/oauth/',                  // provider OAuth device flow — `start` spawns
                              // OpenCode + waits for the device challenge, which
                              // can exceed the deadline on a cold replica
];

// Long synchronous creates that can't be matched by fragment without
// catching unrelated routes: method + exact path (or path prefix) pairs.
const EXEMPT_METHOD_PATHS: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/v1/projects' },          // create + seed + provision
];

function isExempt(c: Context): boolean {
  // WebSocket upgrade (defensive — these are handled before app.fetch).
  if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return true;
  // Any SSE client explicitly asks for an event stream — robust catch-all for
  // streaming endpoints not covered by the prefix/fragment lists.
  if (c.req.header('accept')?.includes('text/event-stream')) return true;

  const path = c.req.path;
  for (const p of EXEMPT_PREFIXES) {
    if (path === p || path.startsWith(p + '/')) return true;
  }
  for (const f of EXEMPT_FRAGMENTS) {
    if (path.includes(f)) return true;
  }
  for (const mp of EXEMPT_METHOD_PATHS) {
    if (c.req.method === mp.method && path === mp.path) return true;
  }
  return false;
}

// Built once — duration is constant for the process lifetime.
const bounded = timeout(
  Math.max(DEADLINE_MS, 1),
  () =>
    new HTTPException(503, {
      message: `Request exceeded the ${Math.round(DEADLINE_MS / 1000)}s server processing deadline`,
    }),
);

export async function requestDeadline(c: Context, next: Next): Promise<void | Response> {
  if (!ENABLED || isExempt(c)) {
    await next();
    return;
  }
  return bounded(c, next);
}
