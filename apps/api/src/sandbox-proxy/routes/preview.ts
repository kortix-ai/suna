import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { config } from '../../config';
import { getTraceHeaders } from '../../lib/request-context';
import { syncSandboxEnvForPrompt } from '../../projects/lib/sandbox-env-sync';
import { canAccessPreviewSandbox, canAccessSandboxSession } from '../../shared/preview-ownership';
import { KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import {
  buildSandboxUpstreamHeaders,
  invalidatePreviewLink,
  loadSandbox,
  markSandboxErrored,
  markSandboxUsed,
  resolvePreviewLink,
  wakeSandbox,
} from '../backend';
import { PROXY_RETRY_BUDGET_MS, proxyAttemptTimeoutMs } from '../preview-retry-budget';

const KORTIX_USER_CONTEXT_QUERY_PARAM = '__kortix_user_context';

// `userId` is set by combinedAuth (mounted in ../index.ts) before this route.
const preview = new Hono<{ Variables: { userId: string; userEmail: string } }>();

// Hop-by-hop + caller-controlled headers we never forward upstream. Auth is
// replaced with the sandbox service key, trace headers are regenerated, and
// Accept-Encoding is forced to identity (raw byte passthrough).
const STRIP_FORWARD_HEADERS = new Set([
  'host',
  'authorization',
  'traceparent',
  'x-request-id',
  'accept-encoding',
  'content-length',
]);

function jsonProxyError(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback);
}

const RETRYABLE_ENV_SYNC_NETWORK_ERROR_RE =
  /\b(operation timed out|timeout|aborterror|unable to connect|connection refused|econnrefused|econnreset|socket hang up)\b/i;

function isRetryableEnvSyncFailure(message: string): boolean {
  if (/\benv sync failed: (502|503|504)\b/i.test(message)) return true;
  // Fetch rejections are bare network errors. HTTP failures include the daemon
  // response body, so don't classify a non-retryable status as transient just
  // because its JSON/body happens to mention a connection failure.
  if (/^env sync failed:/i.test(message)) return false;
  return RETRYABLE_ENV_SYNC_NETWORK_ERROR_RE.test(message);
}

// Remove the `frame-ancestors` directive from a CSP value, preserving the rest.
// Returns null if nothing meaningful remains (so the header can be dropped).
function stripFrameAncestors(csp: string): string | null {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  return kept.length ? kept.join('; ') : null;
}

// Build the response headers we send back to the browser: clone the upstream
// headers, neutralize framing restrictions, and apply CORS. Previews are
// embedded in the Kortix session UI via an <iframe>, so any app that ships
// `X-Frame-Options` or a CSP `frame-ancestors` (Next.js, and most frameworks,
// default to these) would otherwise refuse to load in the panel. Stripping them
// at the proxy makes embedding work for ANY project without per-app config —
// the same project-agnostic approach as the origin/host re-origination above.
// This is safe for previews: access is already gated by the preview token +
// ownership check, so they aren't world-framable.
function clientResponseHeaders(upstreamHeaders: Headers, origin: string): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.delete('x-frame-options');
  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    const csp = headers.get(key);
    if (csp && /frame-ancestors/i.test(csp)) {
      const next = stripFrameAncestors(csp);
      if (next) headers.set(key, next);
      else headers.delete(key);
    }
  }
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return headers;
}

// Is this request a top-level browser navigation (so it expects an HTML page,
// not JSON)? Used to decide whether an "unreachable" state renders a friendly
// page or a machine-readable error. `Accept: text/html` is the standard signal;
// `sec-fetch-dest` covers document/iframe loads that send a terse Accept.
function isBrowserNavigation(incomingHeaders: Headers): boolean {
  const accept = incomingHeaders.get('accept') || '';
  if (accept.includes('text/html')) return true;
  const dest = incomingHeaders.get('sec-fetch-dest') || '';
  return dest === 'document' || dest === 'iframe' || dest === 'frame';
}

// Minimal, dependency-free HTML shown when a sandbox port can't be reached —
// instead of the browser's bare "HTTP ERROR 502" interstitial. Self-contained
// (inline CSS/JS), dark-mode aware, and gently auto-retries a few times to ride
// out the boot window before falling back to a manual Retry button.
function portUnreachableHtml(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Port ${port} isn't responding</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #fafafa; color: #18181b; padding: 24px;
  }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #e4e4e7; } }
  .card { max-width: 420px; width: 100%; text-align: center; }
  .dot {
    width: 10px; height: 10px; border-radius: 999px; background: #f59e0b;
    display: inline-block; margin-right: 8px; vertical-align: middle;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 6px; color: #71717a; }
  @media (prefers-color-scheme: dark) { p { color: #a1a1aa; } }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .actions { margin-top: 20px; }
  button {
    font: inherit; font-weight: 500; cursor: pointer;
    padding: 8px 16px; border-radius: 8px; border: 1px solid #e4e4e7;
    background: #18181b; color: #fafafa; transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  @media (prefers-color-scheme: dark) { button { background: #fafafa; color: #18181b; border-color: #27272a; } }
  .status { margin-top: 14px; font-size: 12px; color: #a1a1aa; min-height: 16px; }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>Port ${port} isn't responding yet</h1>
    <p>Nothing is answering on <code>localhost:${port}</code>.</p>
    <p>The service may still be starting, or it isn't running.</p>
    <div class="actions"><button id="retry" type="button">Retry now</button></div>
    <div class="status" id="status"></div>
  </div>
  <script>
    (function () {
      var KEY = 'kortix-preview-retries-${port}';
      var MAX = 5, DELAY = 4000;
      var n = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0;
      var statusEl = document.getElementById('status');
      function reload() { sessionStorage.setItem(KEY, String(n + 1)); location.reload(); }
      document.getElementById('retry').addEventListener('click', function () {
        sessionStorage.setItem(KEY, '0'); location.reload();
      });
      if (n < MAX) {
        var left = Math.round(DELAY / 1000);
        statusEl.textContent = 'Retrying automatically in ' + left + 's… (' + (n + 1) + '/' + MAX + ')';
        var t = setInterval(function () {
          left -= 1;
          statusEl.textContent = left > 0
            ? 'Retrying automatically in ' + left + 's… (' + (n + 1) + '/' + MAX + ')'
            : 'Retrying…';
        }, 1000);
        setTimeout(function () { clearInterval(t); reload(); }, DELAY);
      } else {
        statusEl.textContent = 'Still not responding after several tries. Use Retry once the service is up.';
      }
    })();
  </script>
</body>
</html>`;
}

// Response for an unreachable / not-yet-ready sandbox port: a friendly HTML page
// for browser navigations, machine-readable JSON otherwise. Marked no-store so a
// retry always re-hits the upstream instead of a cached error.
function portUnreachableResponse(opts: {
  port: number;
  status: number;
  origin: string;
  incomingHeaders: Headers;
  reason: string;
}): Response {
  const { port, status, origin, incomingHeaders, reason } = opts;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  if (isBrowserNavigation(incomingHeaders)) {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(portUnreachableHtml(port), { status, headers });
  }
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({ error: reason, port, status }), { status, headers });
}

// Rewrite an upstream redirect Location so the user stays on the preview.
// `redirectPrefix` is the URL prefix that maps to this sandbox port:
//   - subdomain previews (p{port}-{sandbox}.host):  '' (root-relative)
//   - path-based previews (/v1/p/{sandbox}/{port}):  '/v1/p/{sandbox}/{port}'
// App self-redirects (relative, or absolute to the upstream's own origin) are
// kept on the preview. Genuinely external redirects (OAuth, CDNs, …) pass
// through unchanged so the browser can follow them — we never hard-block, since
// blocking turned ordinary app redirects into 502s.
function sanitizeRedirectLocation(
  previewUrl: string,
  location: string | null,
  redirectPrefix: string,
): string | null {
  if (!location) return null;
  if (location.startsWith('/') && !location.startsWith('//')) {
    return `${redirectPrefix}${location}`;
  }
  try {
    const target = new URL(location, previewUrl);
    const preview = new URL(previewUrl);
    const selfHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(target.hostname);
    if (target.origin === preview.origin || selfHost) {
      return `${redirectPrefix}${target.pathname}${target.search}${target.hash}`;
    }
    return location;
  } catch {
    return null;
  }
}

// === Project-env pre-sync (before a prompt reaches opencode) ===

function shouldSyncProjectEnvBeforeProxy(port: number, method: string, path: string): boolean {
  if (port !== 8000) return false;
  if (method.toUpperCase() !== 'POST') return false;
  return /^\/session\/[^/]+\/(?:prompt_async|message)(?:$|[/?#])/.test(path);
}

function requestedPromptAgent(body: ArrayBuffer | undefined, incomingHeaders: Headers): string | null {
  if (!body) return null;
  const contentType = incomingHeaders.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { agent?: unknown };
    return typeof parsed.agent === 'string' && parsed.agent.trim() ? parsed.agent.trim() : null;
  } catch {
    return null;
  }
}

function agentSwitchConflictResponse(expectedAgent: string, requestedAgent: string): Response {
  return jsonProxyError({
    error: 'agent switch requires a new session',
    code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION',
    expected_agent: expectedAgent,
    requested_agent: requestedAgent,
  }, 409);
}

// The sentinel name a session carries when it isn't bound to a *concrete* agent.
// `project_sessions.agent_name` defaults to this, and no agent is literally named
// "default" — the runtime resolves it to OpenCode's configured `default_agent`
// (conventionally `kortix`). It is therefore non-binding: a "default" session's
// executor token carries the least-privileged grant (null = full for ungoverned
// projects, deny for governed ones — see `grantFromLoadedAgents`), so a prompt
// can never use it to escalate into another agent's connector / Kortix-CLI grant.
const DEFAULT_AGENT_SENTINEL = 'default';

// A prompt's explicit `agent` only constitutes a prohibited switch when it would
// run a DIFFERENT *concrete* agent than the one this session's executor token was
// minted for. That — and only that — is the escalation the policy prevents (see
// docs/specs/2026-06-28-token-session-agent-identity.md). The sentinel 'default'
// is non-binding on EITHER side: a session stored as 'default' has no privileged
// agent-specific grant to inherit, and a prompt asking for 'default' just means
// "this session's own default agent".
//
// Without this, the client's perfectly ordinary behaviour read as a bogus switch:
// it resolves "the default" to a concrete name (e.g. `kortix`) for display and
// echoes it back on follow-up turns — and a first-turn race can send that name
// before the session's bound agent has even loaded. Comparing the concrete echo
// against the stored sentinel 409'd every "start a new session, send a second
// message" flow (the false AGENT_SWITCH_REQUIRES_NEW_SESSION reports).
function isProhibitedAgentSwitch(requestedAgent: string | null, sessionAgent: string): boolean {
  if (!requestedAgent) return false;
  if (requestedAgent === DEFAULT_AGENT_SENTINEL) return false;
  if (sessionAgent === DEFAULT_AGENT_SENTINEL) return false;
  return requestedAgent !== sessionAgent;
}

// Drop the prompt's `agent` field entirely so OpenCode resolves its own
// `default_agent`. Used for non-concrete ('default') sessions: the box must
// always run the agent it booted with — the one the executor token was minted
// for — regardless of which concrete name the client speculatively echoed.
function bodyWithoutPromptAgent(body: ArrayBuffer | undefined, incomingHeaders: Headers): ArrayBuffer | undefined {
  if (!body) return body;
  const contentType = incomingHeaders.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return body;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { agent?: unknown };
    if (!('agent' in parsed)) return body;
    delete parsed.agent;
    return new TextEncoder().encode(JSON.stringify(parsed)).buffer;
  } catch {
    return body;
  }
}

// === Core HTTP forwarder ======================================================
//
// Forwards one request to a sandbox port with the full upstream auth header set,
// auto-wake retries, redirect rewriting, and CORS injection. Exported so both
// proxy edges use it: the path-based Hono route below and the subdomain handler
// (src/sandbox-proxy/subdomain.ts).

export type PreviewProxyAccess =
  | { kind: 'principal'; userId: string }
  | { kind: 'public_share' };

function principalUserId(access: PreviewProxyAccess): string {
  return access.kind === 'principal' ? access.userId : '';
}

export async function forwardToSandbox(
  sandboxId: string,
  port: number,
  access: PreviewProxyAccess,
  method: string,
  remainingPath: string,
  queryString: string,
  incomingHeaders: Headers,
  body: ArrayBuffer | undefined,
  origin: string,
  // URL prefix that maps to this sandbox port, used to rewrite redirects.
  // Defaults to the path-based form; subdomain callers pass '' (root-relative).
  redirectPrefix: string = `/v1/p/${sandboxId}/${port}`,
  // Public origin (scheme://host) the client used to reach this sandbox port.
  // Combined with `redirectPrefix` to form X-Forwarded-Prefix — the full public
  // base URL the sandbox needs so the static-web <base> tag and OpenAPI server
  // URL resolve to browser-reachable addresses. Callers pass this explicitly so
  // the scheme is correct in every environment (http in local dev, https behind
  // a TLS-terminating LB). Falls back to reconstructing from the Host header.
  publicOrigin?: string,
): Promise<Response> {
  // 1. One row fetch — enforces the v1 session-sandbox contract, ownership, and
  // active state, and yields the service key for upstream auth. (Previously two
  // separate queries for the same row.)
  const record = await loadSandbox(sandboxId);
  if (!record) {
    return jsonProxyError({ error: 'sandbox not found' }, 404);
  }
  const userId = principalUserId(access);
  if (
    access.kind === 'principal'
    && !(await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }))
  ) {
    throw new HTTPException(403, {
      message: `Not authorized to access this sandbox, userId: ${userId}, sandboxId: ${sandboxId}`,
    });
  }
  // The daemon port serves the session's OpenCode conversation + owner-synced
  // secrets; gate it on SESSION visibility (mirrors loadVisibleSession on the
  // REST side), not just account membership — closes the window where a member
  // whose access was revoked/downgraded replays captured ids on the data path.
  if (
    access.kind === 'principal' &&
    port === 8000 &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
    }))
  ) {
    throw new HTTPException(403, { message: 'Not authorized to access this session' });
  }
  // /kortix/env is a platform-only control endpoint that writes the sandbox's
  // live secret env. The API reaches it server-to-server (postEnvToDaemon),
  // never through this user-facing proxy — block it so an account member can't
  // inject arbitrary env into a sandbox by POSTing /v1/p/<id>/8000/kortix/env.
  if (port === 8000 && /^\/kortix\/env(?:$|[/?#])/.test(remainingPath)) {
    return jsonProxyError({ error: 'not found' }, 404);
  }
  if (record.status !== 'active') {
    return portUnreachableResponse({
      port,
      status: 503,
      origin,
      incomingHeaders,
      reason: `sandbox not ready (status: ${record.status})`,
    });
  }
  const serviceKey = record.serviceKey;

  // 2. Forward with auto-wake retry.
  const MAX_RETRIES = 3;
  // Short early delays so a transient post-restore RX stall (CH virtio-net misses
  // the first RX interrupt → daemon briefly unreachable ~1s) clears on the next
  // attempt instead of stretching to seconds. The old [2000,5000,8000] turned a
  // ~1s stall into the multi-second session-list lag observed in-browser
  // (opencode-listed +5578ms, 2026-06-14). Later delays stay progressive for a
  // genuinely cold-booting port.
  const RETRY_DELAYS_MS = [250, 1000, 3000];
  let wakeTriggered = false;
  // Only a CONFIRMED-dead provider signal (box stopped/archived) errors the row.
  // A transient unreachable / RX stall must NEVER error a sandbox whose daemon
  // health is green — that briefly flipped healthy boxes to 'error' (surfacing
  // the chat as failed + lagging the session list, 2026-06-14). For microVM
  // providers there is no such signal, so the preview proxy never errors the row;
  // liveness is owned by the health-check loop + reconciler, not a port request.
  let sawDeadSignal = false;

  // Wall-clock budget so a cold/dead sandbox returns our friendly page BEFORE
  // the 60s ALB idle timeout severs the connection (→ Cloudflare's bare 502).
  const proxyStartedAt = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const budgetRemainingMs = PROXY_RETRY_BUDGET_MS - (Date.now() - proxyStartedAt);
    if (budgetRemainingMs <= 500) break; // out of budget → friendly page below
    try {
      const { url: previewUrl, token: previewToken } = await resolvePreviewLink(record, port);
      const targetUrl = previewUrl.replace(/\/$/, '') + remainingPath + queryString;

      if (shouldSyncProjectEnvBeforeProxy(port, method, remainingPath)) {
        const requestedAgent = requestedPromptAgent(body, incomingHeaders);
        const sessionAgent = record.agentName ?? DEFAULT_AGENT_SENTINEL;
        // Agent-lock enforcement is OFF by default — in-session agent switching is
        // allowed. The 409 only fires when KORTIX_ENFORCE_SESSION_AGENT_LOCK is
        // explicitly enabled (a future per-agent executor-token auth model; see the
        // config flag's TODO). Until then a prompt may freely run a different agent.
        if (
          config.KORTIX_ENFORCE_SESSION_AGENT_LOCK &&
          isProhibitedAgentSwitch(requestedAgent, sessionAgent)
        ) {
          return agentSwitchConflictResponse(sessionAgent, requestedAgent!);
        }
        // Drop only the legacy 'default' sentinel so OpenCode resolves its own
        // `default_agent` (the real default the session booted with). A *concrete*
        // requested agent is forwarded untouched so the user can switch agents
        // within a session.
        if (requestedAgent === DEFAULT_AGENT_SENTINEL) {
          body = bodyWithoutPromptAgent(body, incomingHeaders);
        }
        try {
          await syncSandboxEnvForPrompt({
            projectId: record.projectId,
            sessionId: record.sessionId,
            serviceKey,
            previewUrl,
            previewToken,
          });
        } catch (err) {
          const message = errorMessage(err, 'project env sync failed');
          if (isRetryableEnvSyncFailure(message)) {
            // Treat daemon/preview-transient env-sync failures like any other
            // sandbox-port reachability miss: retry/wake in the outer loop, then
            // return the friendly port-unreachable response if the sandbox never
            // recovers. Throwing HTTPException here bypassed that retry path and
            // turned expected 502/timeouts from Daytona into Better Stack errors.
            throw new Error(message);
          }
          console.warn(`[PREVIEW] Project env sync failed for ${sandboxId}:${port}: ${message}`);
          return jsonProxyError({ error: message }, 502);
        }
      }

      // Build forwarding headers: copy the client's (minus stripped), force
      // identity encoding, regenerate trace headers, then apply the sandbox
      // auth/identity headers (service key, preview token, signed user-context)
      // last so they always win.
      const headers = new Headers();
      for (const [key, value] of incomingHeaders.entries()) {
        if (STRIP_FORWARD_HEADERS.has(key.toLowerCase())) continue;
        headers.set(key, value);
      }
      headers.set('Accept-Encoding', 'identity');
      for (const [key, value] of Object.entries(getTraceHeaders())) {
        headers.set(key, value);
      }
      const authHeaders = await buildSandboxUpstreamHeaders({
        sandboxId,
        userId,
        serviceKey,
        previewToken,
      });
      for (const [key, value] of Object.entries(authHeaders)) {
        headers.set(key, value);
      }

      // Re-originate the request to the upstream so the sandbox dev server sees a
      // CONSISTENT origin/host pair. The browser's Origin reflects OUR public proxy
      // host (p3000-<id>.localhost:8008 or the path-based API host), but the upstream
      // is reached at `previewUrl` and — behind Daytona — sees a `host`/`x-forwarded-host`
      // of the Daytona proxy (3000-<id>.daytonaproxy01.net). Frameworks that enforce
      // same-origin on mutations (Next.js Server Actions, SvelteKit, Remix, Django CSRF)
      // reject that mismatch as "Invalid Server Actions request." Rewriting Origin (and
      // pinning x-forwarded-host for single-hop upstreams) to the upstream
      // origin makes this proxy transparent to ANY framework — no per-project config.
      const upstreamUrl = new URL(previewUrl);
      if (headers.has('origin')) {
        headers.set('origin', upstreamUrl.origin);
      }
      headers.set('x-forwarded-host', upstreamUrl.host);

      // Public base URL the client used, so the sandbox emits browser-reachable
      // URLs (static-web <base> tag, OpenAPI server URL). origin + redirectPrefix
      // is exactly the prefix the client sees.
      const resolvedOrigin =
        publicOrigin ??
        (() => {
          const originalHost = incomingHeaders.get('host');
          if (!originalHost) return null;
          const proto = incomingHeaders.get('x-forwarded-proto') || 'https';
          return `${proto}://${originalHost}`;
        })();
      if (resolvedOrigin) {
        headers.set('X-Forwarded-Prefix', `${resolvedOrigin}${redirectPrefix}`);
      }

      // Only log retries — the happy path is already covered by the
      // per-request "Request completed" INFO line, and logging every proxied
      // asset (e.g. each _next/static chunk) floods the console.
      if (attempt > 0) {
        console.log(
          `[PREVIEW] ${method} ${sandboxId}:${port}${remainingPath} -> ${targetUrl} (retry ${attempt})`,
        );
      }

      const upstream = await fetch(targetUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        // Bound a wedged first connection to a freshly-restored microVM (residual
        // CH RX stall) so the attempt fails fast → retry on a fresh connection,
        // instead of hanging the whole proxy. `body` is buffered (line ~576, not
        // a stream) so aborting only kills the in-flight attempt, never truncates
        // an upload mid-stream.
        signal: AbortSignal.timeout(proxyAttemptTimeoutMs(budgetRemainingMs)),
        // Bun extensions: no decompression (raw byte passthrough), duplex streaming —
        // not in the lib RequestInit type.
        decompress: false,
        duplex: 'half',
      } as RequestInit);

      if (upstream.status >= 300 && upstream.status < 400) {
        const respHeaders = clientResponseHeaders(upstream.headers, origin);
        const safeLocation = sanitizeRedirectLocation(
          previewUrl,
          upstream.headers.get('location'),
          redirectPrefix,
        );
        if (safeLocation) respHeaders.set('Location', safeLocation);
        return new Response(null, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: respHeaders,
        });
      }

      if (upstream.status === 401 && serviceKey && userId) {
        console.warn(`[PREVIEW] Sandbox ${sandboxId}:${port} rejected signed user context`);
        return jsonProxyError({ error: 'sandbox proxy authentication rejected' }, 502);
      }

      // Daytona returns various error codes when the sandbox isn't ready:
      //   400 "no IP address found" — sandbox is stopped
      //   400 "failed to get runner info" — sandbox is archived (no runner)
      //   502 — container started but the port isn't listening yet
      //   503 — sandbox service temporarily unavailable
      // Retry with auto-wake so users don't see errors during the boot window.
      if (upstream.status === 503) {
        const bodyText = await upstream.clone().text().catch(() => '');
        if (bodyText.includes('opencode not ready')) {
          void markSandboxUsed(sandboxId);
          const notReadyHeaders = clientResponseHeaders(upstream.headers, origin);
          return new Response(bodyText, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: notReadyHeaders,
          });
        }
      }

      if (upstream.status === 502 || upstream.status === 503) {
        if (attempt < MAX_RETRIES) {
          // Port not ready yet — sandbox is booting (container running, port down).
          console.warn(
            `[PREVIEW] Sandbox ${sandboxId}:${port} returned ${upstream.status} (port not ready, attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
          );
          invalidatePreviewLink(sandboxId, port);
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        // Retries exhausted and the port still isn't answering. Show the friendly
        // "port unreachable" page to browsers instead of the upstream's bare 5xx;
        // programmatic clients still get the real status + JSON via passthrough.
        if (isBrowserNavigation(incomingHeaders)) {
          void markSandboxUsed(sandboxId);
          return portUnreachableResponse({
            port,
            status: upstream.status,
            origin,
            incomingHeaders,
            reason: 'sandbox port unreachable',
          });
        }
      }

      if (upstream.status === 400 && attempt < MAX_RETRIES) {
        const bodyText = await upstream.text();
        const isSandboxDown =
          bodyText.includes('no IP address found') ||
          bodyText.includes('failed to get runner info');
        if (isSandboxDown) {
          sawDeadSignal = true; // confirmed-dead → erroring the row is justified
          if (!wakeTriggered) {
            console.warn(
              `[PREVIEW] Sandbox ${sandboxId} is stopped/archived (Daytona: ${bodyText.slice(0, 120)}), triggering wake`,
            );
            await wakeSandbox(sandboxId);
            wakeTriggered = true;
          } else {
            console.warn(
              `[PREVIEW] Sandbox ${sandboxId} still booting (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
            );
          }
          invalidatePreviewLink(sandboxId, port);
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        // Not a Daytona stopped error — pass through.
        const errHeaders = clientResponseHeaders(upstream.headers, origin);
        return new Response(bodyText, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: errHeaders,
        });
      }

      // Got an HTTP response → sandbox is alive, pass it through with CORS.
      void markSandboxUsed(sandboxId);
      const respHeaders = clientResponseHeaders(upstream.headers, origin);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      // Re-throw our own HTTP exceptions (400, 403, etc.) — don't retry those.
      if (err instanceof HTTPException) throw err;

      console.warn(
        `[PREVIEW] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${sandboxId}:${port}: ${(err as Error).message || err}`,
      );

      if (!wakeTriggered) {
        await wakeSandbox(sandboxId);
        wakeTriggered = true;
      }
      if (attempt < MAX_RETRIES) {
        invalidatePreviewLink(sandboxId, port);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // All retries exhausted. Only error the row when the provider CONFIRMED the
  // sandbox is dead — never on a transient unreachable / RX stall, which would
  // flip a health-green box to 'error' (the chat-failed + session-list-lag bug,
  // 2026-06-14). When not confirmed-dead, fail just this request gracefully; the
  // health-check loop owns liveness and will retry the box.
  if (sawDeadSignal) {
    await markSandboxErrored(sandboxId);
  }
  return portUnreachableResponse({
    port,
    status: 502,
    origin,
    incomingHeaders,
    reason: 'sandbox upstream unreachable',
  });
}

// === WebSocket upstream resolution =============================================
//
// Resolves the upstream WS URL + auth headers for a preview WebSocket. The
// actual upgrade + byte-piping happens at the Bun.serve level (ws-proxy.ts);
// this reuses the exact same ownership gate, service key, and signed
// user-context as the HTTP forwarder so the security posture is identical.

export async function resolvePreviewWsUpstream(opts: {
  sandboxId: string;
  upstreamPort: number;
  userId: string;
  remainingPath: string;
  queryString: string;
}): Promise<
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; status: number; message: string }
> {
  const { sandboxId, userId, remainingPath, queryString } = opts;

  const record = await loadSandbox(sandboxId);
  if (!record) return { ok: false, status: 404, message: 'sandbox not found' };

  // Platinum cannot safely expose OpenCode's loopback-only 4096 port directly.
  // PTY WebSockets for Platinum go through the sandbox agent on 8000, which
  // validates X-Kortix-User-Context and bridges to localhost:4096 in-box.
  const upstreamPort =
    remainingPath.startsWith('/pty/') && record.provider === 'platinum'
      ? 8000
      : opts.upstreamPort;

  if (!(await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }))) {
    return { ok: false, status: 403, message: 'not authorized' };
  }
  // Daemon port (8000) carries session conversation data — gate on session
  // visibility, not just account membership (see forwardToSandbox).
  if (
    upstreamPort === 8000 &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
    }))
  ) {
    return { ok: false, status: 403, message: 'not authorized for this session' };
  }
  if (record.status !== 'active') {
    return { ok: false, status: 503, message: 'sandbox not ready' };
  }

  const { url: previewUrl, token: previewToken } = await resolvePreviewLink(record, upstreamPort);
  const wsBase = previewUrl
    .replace(/\/$/, '')
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:');
  const headers = await buildSandboxUpstreamHeaders({
    sandboxId,
    userId,
    serviceKey: record.serviceKey,
    previewToken,
  });

  const upstreamUrl = new URL(wsBase + remainingPath + queryString);
  if (remainingPath.startsWith('/pty/') && record.provider === 'platinum') {
    const signedContext = headers[KORTIX_USER_CONTEXT_HEADER];
    if (signedContext) upstreamUrl.searchParams.set(KORTIX_USER_CONTEXT_QUERY_PARAM, signedContext);
    // opencode's PTY WS replays its scrollback — including the live shell prompt —
    // ONLY when a cursor is supplied. The in-box agent's bridge otherwise defaults
    // the upstream to cursor=-1, which makes opencode skip the buffer entirely, so
    // the terminal renders only a cursor and no prompt (then idles → 1006 loop).
    // This is Platinum-only: Daytona connects to opencode :4096 directly and never
    // hits the agent's ticket+cursor default. Default to replay-from-start when the
    // FE didn't pin a cursor; a FE-supplied cursor (reconnect resume) is preserved
    // by the has() guard. Verified in-box: cursor=0 → "TEXT '# '", cursor=-1 → none.
    if (!upstreamUrl.searchParams.has('cursor')) upstreamUrl.searchParams.set('cursor', '0');
  }

  return { ok: true, url: upstreamUrl.toString(), headers };
}

// === Route handlers: ALL /:sandboxId/:port(/*) ===
//
// Thin wrappers around forwardToSandbox — extract params from the Hono context.

preview.all('/:sandboxId/:port/*', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const portStr = c.req.param('port');
  const port = parseInt(portStr, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new HTTPException(400, { message: `Invalid port: ${portStr}` });
  }

  const userId = c.get('userId') as string;

  const method = c.req.method;
  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await c.req.raw.clone().arrayBuffer();
  }

  const fullPath = new URL(c.req.url).pathname;
  const prefixPattern = `/${sandboxId}/${portStr}`;
  const prefixIndex = fullPath.indexOf(prefixPattern);
  const remainingPath =
    prefixIndex !== -1 ? fullPath.slice(prefixIndex + prefixPattern.length) || '/' : '/';
  const upstreamUrl = new URL(c.req.url);
  upstreamUrl.searchParams.delete('token');
  const queryString = upstreamUrl.search;

  const origin = c.req.header('Origin') || '';

  // Public origin the client used. Prefer X-Forwarded-Proto (TLS-terminating LB
  // in prod), else the scheme the request actually arrived on — never assume
  // https, which breaks the static-web <base> tag over http in local dev.
  const proto = c.req.header('x-forwarded-proto') || upstreamUrl.protocol.replace(':', '');
  const host = c.req.header('host') || upstreamUrl.host;
  const publicOrigin = `${proto}://${host}`;

  return forwardToSandbox(
    sandboxId, port, { kind: 'principal', userId }, method, remainingPath, queryString,
    c.req.raw.headers, body, origin,
    undefined, // redirectPrefix → default `/v1/p/{sandbox}/{port}`
    publicOrigin,
  );
});

// Requests without a trailing path (e.g. /:sandboxId/:port) → normalize.
preview.all('/:sandboxId/:port', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const port = c.req.param('port');
  const url = new URL(c.req.url);
  return c.redirect(`/${sandboxId}/${port}/${url.search}`, 301);
});

export { preview };
