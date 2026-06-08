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
//  - Fully env-tunable: REQUEST_DEADLINE_MS sets the budget; set it to 0 to
//    disable the middleware entirely without a redeploy (instant kill switch).

const DEADLINE_MS = (() => {
  const raw = process.env.REQUEST_DEADLINE_MS;
  if (raw === undefined) return 28_000; // default: just under the 30s client abort
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 28_000;
})();

const ENABLED = DEADLINE_MS > 0;

// Route prefixes that stream, long-poll, proxy, or carry arbitrary upstream
// latency and therefore must not be bounded by a fixed deadline.
const EXEMPT_PREFIXES = [
  '/v1/p',        // sandbox preview proxy (SSE event stream, long-poll, ws)
  '/v1/tunnel',   // tunnel SSE (permission-requests) + ws
  '/v1/git',      // git smart-HTTP (large packfile up/download)
  '/v1/router',   // LLM gateway — streamed chat completions
  '/v1/executor', // connector proxy — forwards to arbitrary upstream APIs
];

// Path fragments for streaming endpoints that live under otherwise-bounded
// prefixes (e.g. /v1/projects/:id/turn-stream).
const EXEMPT_FRAGMENTS = ['/turn-stream', '/turn-question', '/provision-stream'];

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
