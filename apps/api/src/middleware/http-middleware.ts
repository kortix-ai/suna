import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { config } from '../lib/config';
import { logger as appLogger } from '../lib/logger';
import { decInFlight, incInFlight, recordHttpRequest } from '../lib/metrics';
import { emitOtelSpan } from '../lib/otel';
import {
  getDiagnosticFields,
  getRequestContext,
  runWithContext,
  setContextField,
} from '../lib/request-context';
import {
  requestClientLogFields,
  requestLogLevel,
  requestTimingLogField,
  shouldSuppressRequestLog,
} from '../lib/request-log-level';
import { installFetchTiming } from '../lib/server-timing';
import { addBreadcrumb } from '../lib/sentry';
import { compressResponse } from './compress';
import { createCorsMiddleware } from './cors';
import { requestDeadline } from './request-deadline';
import { PROXY_HOP_HEADER, PROXY_UPSTREAM_STATUS_HEADER } from '../sandbox-proxy/proxy-hop';
import { upstreamTiming } from './upstream-timing';
import { auditApiRequest } from '../services/audit/audit';
import { isUuid } from '../lib/validate';

// The global middleware chain, in the registration order the request sees it.
// Every line inside installHttpMiddleware is moved verbatim from the former
// index.ts; the chain order is the behavior, so nothing is reordered.
export function installHttpMiddleware(app: OpenAPIHono) {
app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/metrics' || path.startsWith('/health') || path.startsWith('/v1/health')) {
    return next();
  }
  const start = performance.now();
  incInFlight();
  let status = 0;
  try {
    await next();
    status = c.res.status;
  } catch (err) {
    // Record the thrown status (e.g. the request-deadline 503), not a blanket
    // 500 — otherwise deadline hits are unattributable per route in metrics.
    status = err instanceof HTTPException ? err.status : 500;
    throw err;
  } finally {
    decInFlight();
    recordHttpRequest({
      method: c.req.method,
      route: c.req.routePath || path,
      status: status || c.res.status,
      durationSeconds: (performance.now() - start) / 1000,
    });
  }
});

// === Global Middleware ===

// Response compression. Mounted at the OUTSIDE of the chain so it sees the
// final response of every route, including the ones the middleware below
// rewrites. Only a NAMED compressible content type is ever compressed, which
// keeps it away from SSE, the sandbox proxy's streams, the secret relay, the
// LLM gateway and git pack transfer; the size floor is applied by peeking one
// kilobyte of the body, never by buffering it. See middleware/compress.ts.
app.use('*', compressResponse);

const extraOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

app.use(
  '*',
  createCorsMiddleware({
    internalEnvironment: config.INTERNAL_KORTIX_ENV,
    extraOrigins,
  }),
);

// ─── Request context (AsyncLocalStorage) ────────────────────────────────────
// Must be FIRST — wraps the entire request lifecycle so all downstream code
// (auth, route handlers, console.error calls) automatically gets context fields
// (requestId, userId, accountId, sandboxId) attached to every log.
app.use('*', async (c, next) => {
  const withRequestFields = async () => {
    // Auto-extract common resource IDs from URL patterns for logs/traces.
    const path = c.req.path;
    const projectSessionMatch = path.match(/\/projects\/([^/]+)\/sessions\/([^/]+)/);
    if (projectSessionMatch && isUuid(projectSessionMatch[1])) {
      setContextField('projectId', projectSessionMatch[1]);
      setContextField('sessionId', projectSessionMatch[2]);
    } else {
      const projectMatch = path.match(/\/projects\/([^/]+)/);
      if (projectMatch && isUuid(projectMatch[1])) {
        setContextField('projectId', projectMatch[1]);
      }
    }
    const sbMatch = path.match(/\/sandbox(?:es)?\/([^/]+)/) || path.match(/\/p\/([^/]+)/);
    if (sbMatch) setContextField('sandboxId', sbMatch[1]);
    await next();
    const ctx = getRequestContext();
    if (ctx) {
      c.header('X-Request-Id', ctx.requestId);
      c.header('traceparent', ctx.traceparent);
    }
  };
  // The server edge (services/audit/audit-edge.ts) already opened this request's
  // context and its audit scope. Reuse it: a second runWithContext would give
  // the handler a fresh store, and every principal it bound would miss the
  // edge's scope. A test driving `app` directly has no edge, so open one here.
  if (getRequestContext()) {
    await withRequestFields();
    return;
  }
  await runWithContext(c.req.method, c.req.path, withRequestFields, c.req.header('traceparent'));
});

// Per-request cost attribution (`Server-Timing: up;dur=…, api;dur=…`). Mounted
// INSIDE the request-context middleware above, because it reads the
// AsyncLocalStorage scope that one creates. See middleware/upstream-timing.ts.
app.use('*', upstreamTiming);
// Outbound HTTP made inside a request is attributed as `gotrue` or `http`.
installFetchTiming(config.SUPABASE_URL);

// Request logger — uses Hono's built-in logger for stdout (Docker captures these)
app.use('*', logger());

// ── Never emit 502/504 to a client that reaches us through Cloudflare ────────
// Cloudflare REPLACES the body of an origin 502/504 with its own HTML "Bad
// gateway" page and drops our headers with it — including
// `x-kortix-proxy-hop` / `x-kortix-upstream-status`, the attribution channel,
// and any JSON `code` a client branches on. Every such response therefore
// reached users as an unreadable HTML page (dev, 2026-08-24) or as
// "AI_APICallError: Bad Gateway" inside a session.
//
// 503 passes through Cloudflare untouched, so the honest upstream status moves
// into `x-kortix-upstream-status` and the JSON body survives. Handlers keep
// returning the semantically correct status internally; this is the single
// place that makes it safe on the wire, instead of ~40 call sites each having
// to remember. Bodyless responses and upgrades are left alone.
// 520-524 are Cloudflare's OWN origin-error statuses. They can appear here
// because the API->gateway hop itself traverses Cloudflare
// (LLM_GATEWAY_PROXY_TARGET is a proxied hostname whose ALB only accepts
// Cloudflare IPs), so an internal-hop failure arrives as a CF HTML page with a
// 52x status and gets relayed onward. No Kortix handler ever returns 52x, so
// normalizing them is unambiguous.
const EDGE_REWRITTEN_STATUSES = new Set([502, 504, 520, 521, 522, 523, 524]);
app.use('*', async (c, next) => {
  await next();
  const res = c.res;
  if (!res || !EDGE_REWRITTEN_STATUSES.has(res.status)) return;
  if (res.status === 101 || (res as { webSocket?: unknown }).webSocket) return;
  const headers = new Headers(res.headers);
  headers.set('x-kortix-upstream-status', String(res.status));
  if (!headers.has('retry-after')) headers.set('retry-after', '5');
  c.res = new Response(res.body, { status: 503, statusText: res.statusText, headers });
});

// Post-request: Sentry breadcrumbs + slow/error request logging
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  const path = c.req.path;
  const method = c.req.method;

  // Propagate userId/accountId to request context (set by auth middleware)
  const userId = (c as any).get('userId') as string | undefined;
  const accountId = (c as any).get('accountId') as string | undefined;
  if (userId) setContextField('userId', userId);
  if (accountId) setContextField('accountId', accountId);

  // Add breadcrumb to Sentry for request context on future errors
  addBreadcrumb(
    `${c.req.method} ${c.req.path} ${status}`,
    {
      method,
      path,
      status,
      duration,
      userAgent: c.req.header('user-agent')?.slice(0, 100),
    },
    'http',
  );

  // Health/liveness probes fire every few seconds from the ALB + kubelet across
  // every pod — by far the highest-volume request. A healthy probe carries no
  // signal, and shipping one log line per probe is what feeds the Better Stack
  // queue toward overflow.
  const isHealthProbe =
    path === '/health' ||
    path === '/v1/health' ||
    path.endsWith('/health/live') ||
    path.endsWith('/health/ready');
  const suppressLog =
    // Expected sandbox proxy noise we intentionally suppress: the designed
    // answers of the parked/booting window — see shouldSuppressRequestLog.
    shouldSuppressRequestLog({
      method,
      path,
      status,
      durationMs: duration,
      proxyHop: c.res.headers.get(PROXY_HOP_HEADER)?.toLowerCase() ?? null,
    }) ||
    // Suppress only SUCCESSFUL probes (a non-2xx still logs, so a
    // failing/degraded probe stays fully visible).
    (isHealthProbe && status < 400);

  if (!suppressLog) {
    // WARN only for a real failure. A slow-but-successful request stays INFO —
    // paging on it fired on ordinary contention (KRTX-627: 174 WARN lines on
    // one read route, none 5xx). Latency regressions stay covered by the
    // infra-sweep's p95 detector, and the line still carries `duration`.
    const level = requestLogLevel(status);
    // On the slow or failed tail, log the per-stage wall-time breakdown the
    // `Server-Timing` header already computes (lib/server-timing.ts), so the
    // next p95 anomaly answers "DB stretch or app-side work" from this line
    // instead of a post-hoc reconstruction (KRTX-468).
    const serverTiming = requestTimingLogField(duration, status);
    appLogger[level](`Request completed: ${method} ${path} ${status} ${duration}ms`, {
      status,
      duration,
      // Allowlisted, non-identifying only — see getDiagnosticFields. This is what
      // makes turn-stream `kind` queryable in CloudWatch Logs Insights; the full
      // request context (which carries identity) still goes to Better Stack only.
      ...getDiagnosticFields(),
      ...requestClientLogFields((name) => c.req.header(name)),
      ...(serverTiming ? { server_timing: serverTiming } : {}),
      // Only on failed proxy requests: identify the failing hop without logging
      // request bodies, response bodies, or any sandbox identity.
      ...(status >= 500 && path.startsWith('/v1/p/')
        ? {
            proxy_hop: c.res.headers.get(PROXY_HOP_HEADER) ?? 'unknown',
            upstream_status: c.res.headers.get(PROXY_UPSTREAM_STATUS_HEADER) ?? '',
          }
        : {}),
    });
    void emitOtelSpan({
      name: `${method} ${path}`,
      kind: 'SERVER',
      startTimeMs: start,
      endTimeMs: Date.now(),
      attributes: {
        'http.method': method,
        'http.route': path,
        'http.status_code': status,
        'http.response.duration_ms': duration,
      },
    });
  }
});

// Pretty JSON in dev mode for easier debugging
if (config.INTERNAL_KORTIX_ENV === 'dev') {
  app.use('*', prettyJSON());
}

// Every route, not just /v1: `/scim/v2` provisions users and changes group
// membership, and was never request-audited. See services/audit/audit-scope.ts.
app.use('*', auditApiRequest);

// Wall-clock deadline for non-streaming requests — returns 503 before the 30s
// client abort instead of hanging. Streaming/proxy/WS surfaces are exempted
// inside the middleware; disable entirely with REQUEST_DEADLINE_MS=0.
app.use('/v1/*', requestDeadline);
}
