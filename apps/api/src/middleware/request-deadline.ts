import type { Context, Next } from 'hono';
import { timeout } from 'hono/timeout';
import { HTTPException } from 'hono/http-exception';

// ─── Request deadline guard ────────────────────────────────────────────────
//
// Defense-in-depth against the fleet-wide "Request timed out after 30s" class
// of incident (2026-06-08). The real root cause was DB connection-pool
// starvation (see packages/db/src/client.ts), but a secondary failure mode is
// any handler that makes a slow downstream call (Daytona, connector, git host)
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
// create/start, deployments, migrations, webhooks) are enumerated below as
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

/** Stable wire code for the API's total request-processing deadline. */
export const REQUEST_DEADLINE_CODE = 'request_deadline' as const;

// Route prefixes that stream, long-poll, proxy, or carry arbitrary upstream
// latency and therefore must not be bounded by a fixed deadline.
const EXEMPT_PREFIXES = [
  '/v1/p', // sandbox preview proxy (SSE event stream, long-poll, ws)
  '/v1/tunnel', // tunnel RPC relay (machine latency) + ws
  '/v1/git', // git smart-HTTP (large packfile up/download)
  '/v1/router', // billed tool proxies (Tavily/Serper/Firecrawl) — upstream latency
  '/v1/llm', // LLM chat completions (streamed; p99 >10s is normal)
  '/v1/llm-gateway', // reverse proxy to the standalone gateway (streamed SSE)
  '/v1/connectors', // connector calls + git/provider sync — arbitrary upstream latency
  '/v1/webhooks', // inbound webhooks (Slack, …) — callers retry, don't truncate
  '/v1/billing/webhooks', // Stripe webhook processing (observed >60s, legit)
  '/v1/billing/revenuecat', // RevenueCat sync — batch reconcile, legit-long
  '/v1/admin', // operator maintenance endpoints — deliberate long ops
  '/kortix-capture', // Capture store passthrough (self-host without a domain): device chunk uploads
  '/v1/mcp', // MCP server — bounds itself at 55 s (waits for turns, runs commands)
];

// Path fragments for streaming or legitimately long *synchronous* endpoints
// that live under otherwise-bounded prefixes (e.g. /v1/projects/:id/...).
// These either boot sandboxes, push git repos, or sweep batches — work that
// can exceed the deadline while behaving correctly. Enumerated from 7 days of
// prod duration data (2026-06-12).
const EXEMPT_FRAGMENTS = [
  '/turn-question',
  '/provision-stream',
  '/provision', // managed repo create + sandbox boot
  '/start', // unified session open: provision/resume + pin
  // resolve
  '/commit-push', // host-driven git commit+push
  '/marketplace/install', // marketplace item install — git-bound like
  // /commit-push (fetch + hash + commit + push)
  '/registry/install', // registry item install — same git-bound path
  '/marketplace/update', // marketplace item update(s) — also matches
  // /marketplace/update-all (path.includes), and
  // (intentionally) the GET .../updates
  // drift-listing routes, which are
  // GitHub-scan-heavy and legitimately long
  '/registry/update', // registry item update — same git-bound path,
  // plus its GET .../updates drift-listing route
  '/snapshots', // sandbox template builds
  '/legacy-migration', // legacy VM → project migration runs
  '/oauth/', // provider OAuth device flow — `start` spawns
  // OpenCode + waits for the device challenge, which
  // can exceed the deadline on a cold replica
];

// Long synchronous creates that can't be matched by fragment without
// catching unrelated routes: method + exact path (or path prefix) pairs.
const EXEMPT_METHOD_PATHS: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/v1/projects' }, // create + seed + provision
];

const EXEMPT_METHOD_PATH_PATTERNS: Array<{ method: string; path: RegExp }> = [
  // Create commits the session and initial prompt together. Racing that write
  // returns a retryable 503 while the session continues provisioning unseen.
  { method: 'POST', path: /^\/v1\/projects\/[^/]+\/sessions$/ },
  // The streaming secret relay. An SSE or long-body relay legitimately outlives
  // any fixed deadline, and `/v1/projects` is not an exempt PREFIX, so without
  // this every relay over 25s dies with a 503 `request_deadline`.
  //
  // A REGEX, not an `EXEMPT_FRAGMENTS` entry: fragments match with
  // `path.includes()`, so a `/relay` fragment would also un-bound anything
  // merely CONTAINING that substring (`/v1/accounts/relayed-billing`). An
  // exemption that is too broad silently removes the guard from routes nobody
  // meant to exempt, which is worse than not having it.
  //
  // The buffered `/broker` sibling is deliberately NOT exempt: it is capped at
  // 1 MiB / 5 MiB and answers in one shot.
  { method: 'POST', path: /\/secrets\/[^/]+\/relay$/ },
  { method: 'POST', path: /\/secrets\/[^/]+\/relay\/ws-ticket$/ },
  // The session runtime stream. It is a never-ending `text/event-stream`, so a
  // 25 s deadline would kill every healthy one on schedule. The `accept:
  // text/event-stream` catch-all above already covers a well-behaved client;
  // this entry means the guard does not depend on the CLIENT setting a header
  // correctly — a curl without `-H accept:` must not be the reason a stream dies.
  { method: 'GET', path: /\/sessions\/[^/]+\/stream$/ },
  // Kortix in Chrome attach. It waits for the person to answer a prompt in Chrome,
  // up to CONSENT_TIMEOUT_MS (chrome/logic.ts, 90 s, under Cloudflare's 100 s
  // proxy timeout). It bounds itself, and answers 408 on timeout.
  { method: 'POST', path: /^\/v1\/chrome\/attach$/ },
  // The ws UPGRADE needs no entry — `isExempt` returns true for any request
  // carrying `Upgrade: websocket` before it reaches these lists.
];

export function isExempt(c: Context): boolean {
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
  for (const mp of EXEMPT_METHOD_PATH_PATTERNS) {
    if (c.req.method === mp.method && mp.path.test(path)) return true;
  }
  return false;
}

// Prompt attachment completion. It stream-verifies (direct) or assembles
// (chunked) up to 50 MiB under its own 85 s Storage bound (`COMPLETE_BOUND_MS`
// in projects/prompt-attachments.ts). The general deadline only races that
// work: the client gets a 503, retries, and starts a second verify while the
// first runs. It is not exempt either: the database waits around the Storage
// work are unbounded, and this guard exists for pool starvation. So it gets a
// longer deadline, with 10 s for those database waits. It answers before
// Cloudflare's 100 s proxy timeout: a 524 would make the SDK retry and download
// the object again. The SDK's 120 s completion timeout is longer still.
// Begin, chunk, and delete answer fast and keep the general deadline.
// The session-log attachment upload (P2.13, `PUT …/log/blobs/<sha256>`) gets the
// same deadline for the same reason: it reads up to 50 MiB from the box, hashes
// it and writes it to Storage, and a 503 makes the daemon send it again.
const ATTACHMENT_COMPLETE = /^\/v1\/projects\/[^/]+\/attachments\/[^/]+\/complete$/;
const LOG_BLOB_UPLOAD = /^\/v1\/projects\/[^/]+\/sessions\/[^/]+\/log\/blobs\/[0-9a-f]{64}$/;
const ATTACHMENT_COMPLETE_DEADLINE_MS = 95_000;

/** This request's wall-clock deadline, or null when it is exempt or the guard is off. */
export function requestDeadlineMs(c: Context): number | null {
  if (!ENABLED || isExempt(c)) return null;
  if ((c.req.method === 'POST' && ATTACHMENT_COMPLETE.test(c.req.path)) || (c.req.method === 'PUT' && LOG_BLOB_UPLOAD.test(c.req.path)))
    return Math.max(DEADLINE_MS, ATTACHMENT_COMPLETE_DEADLINE_MS);
  return DEADLINE_MS;
}

// ─── Deadline orphan classification (KRTX-2583) ────────────────────────────
//
// Hono's `timeout` races the handler against a timer; when the timer wins the
// exception reaches onError, the 503 is served, and the handler CONTINUES
// running with no owner. When that orphan later resumes — prod 2026-10-16
// 22:43:05, request mvbjzd4t-a8d: GET /v1/runtime-assets/manifest spent
// 31.9s waiting out a stalled DB pool — its first context touch
// (`c.header('Cache-Control', 'no-cache')` in the manifest handler) makes
// Hono recreate the already sent Response from its consumed body stream,
// which Bun rejects with `TypeError: Body object should not be disturbed or
// locked`. compose catches at every dispatch level and calls onError a second
// time, which captured that TypeError to Sentry (Better Stack pattern
// 235fd74b…) although the client already had the designed, retryable 503.
//
// The deadline therefore marks the context the moment it fires — the
// exception factory runs inside the timer callback, before anything unwinds —
// and `isDeadlineOrphan` classifies any LATER error from the same context as
// an orphan: its response was already served, so the error can no longer
// reach a client. http-errors.ts logs orphans at warn and skips
// captureException. The deadline exception itself is not an orphan — it IS
// the response.
export const DEADLINE_SERVED_VAR = 'requestDeadlineServed' as const;

export const markDeadlineServed = (c: Context): RequestDeadlineHTTPException => {
  c.set(DEADLINE_SERVED_VAR, true);
  return new RequestDeadlineHTTPException();
};

export const markAttachmentDeadlineServed = (c: Context): RequestDeadlineHTTPException => {
  c.set(DEADLINE_SERVED_VAR, true);
  return new RequestDeadlineHTTPException(Math.max(DEADLINE_MS, ATTACHMENT_COMPLETE_DEADLINE_MS));
};

// Built once — each duration is constant for the process lifetime.
const bounded = timeout(Math.max(DEADLINE_MS, 1), markDeadlineServed);
const completionBounded = timeout(
  Math.max(DEADLINE_MS, ATTACHMENT_COMPLETE_DEADLINE_MS),
  markAttachmentDeadlineServed,
);

/**
 * Dedicated HTTPException subclass for the request-deadline 503.
 *
 * The deadline 503 is an *expected, typed, retryable* degradation — the net is
 * doing its job (bounding a slow downstream / pool-saturated request) and the
 * global onError adds `Retry-After: 10`. It is already recorded per-route in
 * metrics and as a structured warn log, so reporting it to Sentry/Better Stack
 * as an error is pure noise (it was the Better Stack pattern
 * `29af03…` "Request exceeded the 25s server processing deadline"). The global
 * Sentry `ignoreErrors: ['HTTPException']` filter does NOT catch it because the
 * exception *message* is the deadline string, not the literal "HTTPException".
 *
 * Exposing a typed guard lets `onError` classify it out of `captureException`
 * without brittle string-matching, while keeping the 503 response + log intact.
 */
export class RequestDeadlineHTTPException extends HTTPException {
  readonly code = REQUEST_DEADLINE_CODE;

  constructor(deadlineMs = DEADLINE_MS) {
    super(503, {
      message: `Request exceeded the ${Math.round(deadlineMs / 1000)}s server processing deadline`,
    });
  }
}

export function isRequestDeadlineHTTPException(err: unknown): err is RequestDeadlineHTTPException {
  return err instanceof RequestDeadlineHTTPException;
}

/**
 * True when this request's response was already served by the deadline guard
 * (the timer fired, the 503 went out) and `err` therefore belongs to an
 * ORPHANED handler continuation — see the block comment above
 * `DEADLINE_SERVED_VAR`. The deadline exception itself is not an orphan: it
 * is the response.
 */
export function isDeadlineOrphan(c: Context, err: unknown): boolean {
  return c.get(DEADLINE_SERVED_VAR) === true && !isRequestDeadlineHTTPException(err);
}

export async function requestDeadline(c: Context, next: Next): Promise<void | Response> {
  const deadline = requestDeadlineMs(c);
  if (deadline === null) {
    await next();
    return;
  }
  return deadline === DEADLINE_MS ? bounded(c, next) : completionBounded(c, next);
}
