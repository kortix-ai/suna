import { projectSessions } from '@kortix/db';
import { isHarnessId } from '@kortix/shared/harnesses';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { config } from '../../config';
import { PROJECT_ACTIONS, authorize } from '../../iam';
import { getTraceHeaders } from '../../lib/request-context';
import type { ProviderName } from '../../platform/providers';
import {
  type ForeignAgentModeSwitch,
  foreignAgentModeSwitch,
  isAcpModeConfigChange,
} from '../../projects/lib/acp-agent-mode';
import { callerKortixSessionId } from '../../projects/lib/caller-session';
import { syncSandboxEnvForPrompt } from '../../projects/lib/sandbox-env-sync';
import {
  AgentSecretGrantMismatchError,
  SecretGrantResolutionError,
} from '../../projects/lib/secret-grant';
import {
  SessionGrantRemintError,
  remintGrantForAgentSwitch,
} from '../../projects/lib/session-token-grant';
import { scheduleOpencodeSnapshotSync } from '../../projects/opencode-session-snapshot';
import { resumeStoppedSandboxByExternalId } from '../../projects/routes/shared';
import {
  createExtendThrottle,
  extendSandboxDeadline,
  isPreviewUseObservation,
  isSandboxAuthored,
  isTurnStartRequest,
  observeTurnStart,
  previewGrantMs,
} from '../../projects/sandbox-deadline';
import {
  extractPromptInfo,
  generateSessionTitleFromFirstPrompt,
} from '../../projects/session-title-generate';
import { db } from '../../shared/db';
import { KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import { canAccessPreviewSandbox, canAccessSandboxSession } from '../../shared/preview-ownership';
import {
  buildSandboxUpstreamHeaders,
  invalidatePreviewLink,
  loadSandbox,
  markSandboxErrored,
  markSandboxUsed,
  resolveSandboxIngress,
  routeSandboxIngress,
  wakeSandbox,
} from '../backend';
import {
  PROXY_RETRY_BUDGET_MS,
  isLongTurnCompletionRequest,
  proxyAttemptTimeoutMs,
} from '../preview-retry-budget';
import { claimPromptDelivery, promptDeliveryKey, releasePromptDelivery } from '../prompt-dedupe';
import { carriesSessionData } from '../session-data-ports';

// `userId` is set by combinedAuth (mounted in ../index.ts) before this route.
// `apiKeyType` is read to decide whether a request may extend the sandbox's
// deadline: a box holds a credential that authenticates perfectly well, and a
// request it authors itself must never be able to prolong its own life.
const preview = new Hono<{
  Variables: {
    userId: string;
    userEmail: string;
    sessionId?: string;
    apiKeyType?: 'user' | 'sandbox';
  };
}>();

// Hop-by-hop + caller-controlled headers we never forward upstream. Auth is
// replaced with the sandbox service key, trace headers are regenerated, and
// Accept-Encoding is forced to identity (raw byte passthrough).
// Cookies may contain the caller's raw __preview_session credential and must
// never reach arbitrary user-controlled apps running inside the sandbox.
const STRIP_FORWARD_HEADERS = new Set([
  'host',
  'authorization',
  'cookie',
  'traceparent',
  'x-request-id',
  'accept-encoding',
  'content-length',
]);

function jsonProxyError(body: Record<string, unknown>, status: number, origin?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback);
}

// One deadline write per minute per box for HUMAN preview traffic. Mirrors
// SANDBOX_TOUCH_INTERVAL_MS in ../backend.ts, for the same reason: a single page
// load is hundreds of requests and the extend is monotone, so collapsing them
// loses nothing.
const previewUseThrottle = createExtendThrottle(60_000);

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
// out the boot window before falling back to a manual Retry button. Colors and
// the button mirror the web app's tokens (globals.css --secondary/--foreground;
// Button variant="secondary" size="sm").
function portUnreachableHtml(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Port ${port} isn't responding</title>
<style>
  :root {
    color-scheme: light dark;
    --background: oklch(1 0 0);
    --foreground: oklch(0.1448 0 0);
    --secondary: oklch(0.9502 0 0);
    --muted-foreground: oklch(0.5555 0 0);
    --kortix-yellow: oklch(0.732 0.15 90.688);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.1448 0 0);
      --foreground: oklch(0.9851 0 0);
      --secondary: oklch(0.2686 0 0);
      --muted-foreground: oklch(0.709 0 0);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--background); color: var(--foreground); padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card { display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
  h1 { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; margin: 0; }
  .dot {
    width: 8px; height: 8px; border-radius: 999px; background: var(--kortix-yellow);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  button {
    display: inline-flex; align-items: center; justify-content: center;
    height: 28px; padding: 0 12px; border: 0; border-radius: 8px;
    font: inherit; font-weight: 500; cursor: pointer;
    background: var(--secondary); color: var(--foreground);
    transition: background-color .15s;
  }
  button:hover { background: color-mix(in oklab, var(--secondary) 90%, transparent); }
  .status { font-size: 12px; color: var(--muted-foreground); min-height: 18px; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>Port ${port} isn't responding</h1>
    <button id="retry" type="button">Retry</button>
    <p class="status" id="status"></p>
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
        statusEl.textContent = 'Retrying in ' + left + 's\\u2026';
        var t = setInterval(function () {
          left -= 1;
          statusEl.textContent = left > 0 ? 'Retrying in ' + left + 's\\u2026' : 'Retrying\\u2026';
        }, 1000);
        setTimeout(function () { clearInterval(t); reload(); }, DELAY);
      } else {
        statusEl.textContent = 'Still not responding.';
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

// Response for a blocking session-turn (`POST /session/:id/message`) that
// outran the proxy's retry budget while the upstream was still actively
// computing — i.e. NOT the "sandbox is unreachable/dead" case portUnreachableResponse
// describes. Conflating the two is actively misleading: it makes a healthy,
// still-working sandbox look down, and it invites a naive caller to retry the
// exact same (non-idempotent — it would resubmit the user's message) request
// against a connection shape that can never fit it. 504 + a distinct machine
// code let a caller branch on "this call structurally cannot block for that
// long over this connection" and switch to `prompt_async` + the `/global/event`
// SSE stream instead (what the web UI already does). No-store: a retry should
// always re-evaluate the upstream, never replay a cached verdict.
export function longTurnTimeoutResponse(origin: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(
    JSON.stringify({
      error:
        'Turn is still running and outran this connection’s budget. Blocking POST /session/:id/message ' +
        'cannot wait out a long reasoning/tool turn (the ALB idle-times a stalled connection); use ' +
        'prompt_async and consume /global/event (SSE) instead of blocking on this endpoint.',
      code: 'LONG_TURN_PROXY_TIMEOUT',
    }),
    { status: 504, headers },
  );
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

// ACP prompt delivery shares the runtime URL with its GET event stream.
// Inspect the JSON-RPC envelope before applying prompt deduplication.
function acpPromptSessionId(
  method: string,
  upstreamPort: number,
  path: string,
  incomingHeaders: Headers,
  body: ArrayBuffer | undefined,
): string | null {
  if (method.toUpperCase() !== 'POST' || upstreamPort !== SANDBOX_AGENT_PORT || !body) {
    return null;
  }
  if (!incomingHeaders.get('content-type')?.toLowerCase().includes('application/json')) {
    return null;
  }
  const match = path.match(/^\/kortix\/acp\/([^/?#]+)(?:$|[/?#])/);
  if (!match) return null;
  try {
    const routeSessionId = decodeURIComponent(match[1]);
    const envelope = JSON.parse(new TextDecoder().decode(body)) as { method?: unknown };
    // Keyed on the ROUTE id — the ACP server binding, which for a managed ACP
    // session is the project session itself. The envelope's `params.sessionId`
    // is the HARNESS-issued session, which persistAcpSessionIdentity forbids
    // from equalling the server id: requiring the two to match made this return
    // null for every managed ACP prompt, silently disabling prompt dedupe, the
    // retry budget, the snapshot sync and titling on that path.
    return envelope.method === 'session/prompt' ? routeSessionId : null;
  } catch {
    return null;
  }
}

/**
 * The ACP envelope this request carries, when it is one this proxy path can
 * relay into the daemon's ACP endpoint. Null for everything else.
 *
 * `/v1/p/<external_id>/8000/kortix/acp/<server_id>` reaches the SAME daemon
 * endpoint as the managed route in projects/routes/acp.ts, so it is a complete
 * bypass of that route's checks. Verified live 2026-07-30: a
 * `session/set_config_option` posted here was relayed to the harness and changed
 * its mode. Every WHO-RUNS check on the managed route has to exist here too.
 */
function acpEnvelopeFromProxyBody(
  method: string,
  upstreamPort: number,
  path: string,
  incomingHeaders: Headers,
  body: ArrayBuffer | undefined,
): Record<string, unknown> | null {
  if (method.toUpperCase() !== 'POST' || upstreamPort !== SANDBOX_AGENT_PORT || !body) {
    return null;
  }
  if (!incomingHeaders.get('content-type')?.toLowerCase().includes('application/json')) {
    return null;
  }
  if (!/^\/kortix\/acp\/[^/?#]+(?:$|[/?#])/.test(path)) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Refuse an ACP `mode` change that names an agent other than the one this session
 * committed to. Same rule and same 409 as the managed route — see
 * projects/lib/acp-agent-mode.ts for why, and for why only OpenCode is policed.
 *
 * The session lookup is paid ONLY on a real `mode` change, which is rare: a
 * prompt, a model change or any other relayed method returns before it.
 */
async function foreignAgentModeSwitchOnProxy(
  sessionId: string,
  envelope: Record<string, unknown>,
): Promise<ForeignAgentModeSwitch | null> {
  if (!isAcpModeConfigChange(envelope)) return null;
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  // An unreadable/absent session row leaves the harness unknown. Do NOT guess:
  // an unknown harness is not provably OpenCode, and refusing every mode change
  // on a row we cannot read would break Claude/Codex permission changes for a
  // reason unrelated to agent identity. The managed route and the box-side guard
  // still cover this envelope.
  if (!isHarnessId(metadata.runtime_harness)) return null;
  return foreignAgentModeSwitch(
    {
      runtimeHarness: metadata.runtime_harness,
      nativeAgent: typeof metadata.native_agent === 'string' ? metadata.native_agent : null,
    },
    envelope,
  );
}

// True only when a fetch failure PROVES nothing reached the box: the upstream
// actively refused the connection (nothing was ever accepted). Any other thrown
// error — timeout, abort, connection reset mid-flight — is ambiguous: the
// sandbox may already have received and accepted the prompt, so a re-send would
// duplicate it. Used to gate the one safe prompt-delivery retry in the catch.
function isConnectionRefusedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  const codes = [e.code, e.cause?.code].filter((c): c is string => typeof c === 'string');
  if (codes.some((c) => c === 'ECONNREFUSED')) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /econnrefused|connection refused|failed to connect|unable to connect/i.test(message);
}

function requestedPromptAgent(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): string | null {
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

function agentSwitchConflictResponse(
  expectedAgent: string,
  requestedAgent: string,
  origin?: string,
): Response {
  return jsonProxyError(
    {
      error: 'agent switch requires a new session',
      code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION',
      expected_agent: expectedAgent,
      requested_agent: requestedAgent,
    },
    409,
    origin,
  );
}

/**
 * Map a secret-grant failure from the pre-prompt env sync onto its response, or
 * null when the error is an ordinary env-sync failure the caller should handle
 * with its existing retry/502 logic.
 *
 * Both cases refuse the prompt rather than forwarding it: the sandbox's env is
 * provisioned for ONE agent's grant, so a prompt we can't prove is entitled to
 * that env must not reach OpenCode. See projects/lib/secret-grant.ts.
 */
export function secretGrantErrorResponse(err: unknown, origin?: string): Response | null {
  // The prompt asked for an agent whose grant differs from the session's. 409,
  // matching the existing agent-immutability contract the web client already
  // codes against — re-scoping now cannot un-read what the session's agent
  // already pulled into the box.
  if (err instanceof AgentSecretGrantMismatchError) {
    return agentSwitchConflictResponse(err.sessionAgent, err.requestedAgent, origin);
  }
  // We could not establish what this agent may read. 503 rather than 502: the
  // sandbox is fine, our ability to VERIFY entitlement is what failed, and
  // retrying is the correct client response.
  // The switch was legal but we could not rewrite the token's grant to match the
  // agent now running. 503 for the same reason as above — and refusing is the
  // point: forwarding would run the new agent against the OLD agent's connector
  // and CLI grants, which is exactly the escalation the re-mint closes.
  if (err instanceof SessionGrantRemintError) {
    return jsonProxyError(
      { error: err.message, code: 'AGENT_SWITCH_GRANT_UNAPPLIED' },
      503,
      origin,
    );
  }
  if (err instanceof SecretGrantResolutionError) {
    return jsonProxyError(
      { error: err.message, code: 'AGENT_SECRET_GRANT_UNRESOLVED' },
      503,
      origin,
    );
  }
  return null;
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
function bodyWithoutPromptAgent(
  body: ArrayBuffer | undefined,
  incomingHeaders: Headers,
): ArrayBuffer | undefined {
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
  | {
      kind: 'principal';
      userId: string;
      /** The caller's own session when the credential is bound to one (a sandbox
       *  token). Kortix-as-a-Backend shares ONE userId across every end-user, so
       *  this is what separates them. Null means a non-session-bound principal.
       *  REQUIRED so a new entry point cannot silently omit it and fail open. */
      callerSessionId: string | null;
      /** True when the SANDBOX ITSELF authored this request (it holds a
       *  credential that produces a perfectly valid principal). Such a request
       *  may never extend the box's deadline — that is the self-renewal this
       *  design exists to delete. REQUIRED, same reasoning as callerSessionId:
       *  a new entry point must not be able to omit it and fail open. */
      sandboxAuthored: boolean;
    }
  | { kind: 'public_share' };

function principalUserId(access: PreviewProxyAccess): string {
  return access.kind === 'principal' ? access.userId : '';
}

// opencode's HTTP/SSE + PTY server binds 127.0.0.1:4096 (loopback-only). Daytona
// (a container) reaches it directly; Platinum (a microVM) has its edge dial the
// guest's eth0 IP, so :4096 is unreachable → 502 ("upstream-unreachable"). This
// is what breaks `kortix sessions connect` / `opencode attach` on Platinum.
//
// The sandbox agent on :8000 (binds 0.0.0.0, reachable) already reverse-proxies
// every path to opencode's localhost:4096 in-box. So for Platinum we route
// opencode(4096) traffic through :8000 — the same bridge the /pty/ WebSocket
// already uses. The 8000-keyed guards below (session-visibility gate, /kortix/env
// block) key on the EFFECTIVE upstream port so rerouted opencode traffic is
// subject to the SAME protection as a direct :8000 request — the reroute changes
// reachability, never the auth/control surface.
const SANDBOX_AGENT_PORT = 8000;

/**
 * Should the data-path proxy WAKE a stopped box instead of 503ing it?
 *
 * Two cases, and the difference between them is the whole point:
 *
 *  - A real user (principal) hitting the OpenCode daemon (port 8000). Always
 *    resumes, as it always has — that is what lets the runtime path auto-resume
 *    like `/start`.
 *  - A real user LOADING A PREVIEW PAGE. `browserNavigation` is the load-bearing
 *    condition: a top-level document / iframe load is a human explicitly opening
 *    the app, which is the same class of intent as clicking into the session. An
 *    asset fetch, an XHR poll or a background stream reconnect is NOT, and must
 *    still 503 — passive resurrection is what produced 1,597 phantom-active
 *    compute rows. Without this branch a user whose dev server had been parked
 *    could never get it back through the preview at all, only by prompting the
 *    agent, which is the "preview ports cannot auto-resume" regression.
 *
 * Never for a request the SANDBOX authored (it holds a credential that resolves
 * to a perfectly valid principal), and never for a non-user (service/share)
 * caller. Pure + exported so the gate is unit-tested without provisioning a box.
 */
export function shouldAutoResumeStoppedSandbox(
  status: string,
  upstreamPort: number,
  accessKind: string,
  opts: { sandboxAuthored?: boolean; browserNavigation?: boolean } = {},
): boolean {
  if (status !== 'stopped' || accessKind !== 'principal') return false;
  if (opts.sandboxAuthored) return false;
  if (upstreamPort === SANDBOX_AGENT_PORT) return true;
  return opts.browserNavigation === true && !carriesSessionData(upstreamPort);
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
  redirectPrefix = `/v1/p/${sandboxId}/${port}`,
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
  let record = await loadSandbox(sandboxId);
  if (!record) {
    return jsonProxyError({ error: 'sandbox not found' }, 404, origin);
  }
  const userId = principalUserId(access);
  const callerSessionId = access.kind === 'principal' ? access.callerSessionId : null;
  if (
    access.kind === 'principal' &&
    !(await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }))
  ) {
    throw new HTTPException(403, {
      message: `Not authorized to access this sandbox, userId: ${userId}, sandboxId: ${sandboxId}`,
    });
  }
  // Effective upstream port: Platinum opencode(4096) → the in-box agent on 8000.
  // The AUTH/CONTROL guards below (session-visibility gate + /kortix/env block)
  // key on THIS via carriesSessionData(), which covers BOTH 8000 and opencode's
  // 4096 — Platinum reroutes 4096→8000, Daytona does not, and gating on 8000
  // alone left the direct-:4096 Daytona path ungated. NOTE:
  // redirectPrefix/X-Forwarded-Prefix and shouldSyncProjectEnvBeforeProxy stay on
  // the client-addressed `port` ON PURPOSE — the prefix must reflect the URL the
  // client actually used (/4096), and env-sync-before-prompt must behave identically
  // to Daytona, which likewise skips it on the direct 4096 opencode path.
  const ingressRequest = { port, path: remainingPath, transport: 'http' as const };
  const upstreamPort = routeSandboxIngress(record, ingressRequest).effectivePort;
  // Did the BOX author this request? It holds two credentials that authenticate
  // perfectly well, and every deadline decision below — the turn-start
  // observation, the preview-use extend, the auto-resume — must exclude them or
  // the self-renewing lease this design deletes is rebuilt through the proxy.
  const sandboxAuthored = access.kind === 'principal' && access.sandboxAuthored;
  const acpPromptSession = acpPromptSessionId(
    method,
    upstreamPort,
    remainingPath,
    incomingHeaders,
    body,
  );
  const retryBudgetRequest = {
    method,
    path: remainingPath,
    acpPrompt: acpPromptSession !== null,
  };
  const promptDelivery =
    shouldSyncProjectEnvBeforeProxy(port, method, remainingPath) || acpPromptSession !== null;

  // WHO RUNS, on this edge too. Placed before the dedupe claim and the forward
  // loop so a refusal neither burns the caller's Idempotency-Key nor reaches the
  // box. See foreignAgentModeSwitchOnProxy.
  const proxiedAcpEnvelope = acpEnvelopeFromProxyBody(
    method,
    upstreamPort,
    remainingPath,
    incomingHeaders,
    body,
  );
  if (proxiedAcpEnvelope) {
    const foreignAgent = await foreignAgentModeSwitchOnProxy(record.sessionId, proxiedAcpEnvelope);
    if (foreignAgent) {
      console.warn(
        `[PREVIEW] Refused ACP mode switch on ${sandboxId}: '${foreignAgent.requestedAgent}' != committed '${foreignAgent.expectedAgent}'`,
      );
      return agentSwitchConflictResponse(
        foreignAgent.expectedAgent,
        foreignAgent.requestedAgent,
        origin,
      );
    }
  }

  // The daemon port serves the session's OpenCode conversation + owner-synced
  // secrets; gate it on SESSION visibility (mirrors loadVisibleSession on the
  // REST side), not just account membership — closes the window where a member
  // whose access was revoked/downgraded replays captured ids on the data path.
  if (
    access.kind === 'principal' &&
    carriesSessionData(upstreamPort) &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      callerSessionId: callerSessionId ?? null,
    }))
  ) {
    throw new HTTPException(403, { message: 'Not authorized to access this session' });
  }
  // /kortix/env is a platform-only control endpoint that writes the sandbox's
  // live secret env. The API reaches it server-to-server (postEnvToDaemon),
  // never through this user-facing proxy — block it so an account member can't
  // inject arbitrary env into a sandbox by POSTing /v1/p/<id>/8000/kortix/env.
  if (carriesSessionData(upstreamPort) && /^\/kortix\/env(?:$|[/?#])/.test(remainingPath)) {
    return jsonProxyError({ error: 'not found' }, 404, origin);
  }
  if (record.status !== 'active') {
    // A stopped-but-resumable box hit by a REAL USER on the OpenCode data path
    // (port 8000, principal) should wake in place — the same resume `/start` does —
    // rather than dead-end with a manual-Restart card. This closes the stale-ready
    // gap: /start settles 'ready', the reaper idle-stops the box, and the client's
    // next runtime call used to 503 forever. resumeStoppedSandboxByExternalId is
    // idempotent and its DB conditional lock de-dupes the concurrent session.list
    // retries (one provider start). A human LOADING a preview page resumes too —
    // otherwise a parked dev server could only be recovered by prompting the agent
    // — while passive asset/XHR traffic still 503s, so nothing is resurrected by a
    // background tab. See shouldAutoResumeStoppedSandbox.
    if (
      shouldAutoResumeStoppedSandbox(record.status, upstreamPort, access.kind, {
        sandboxAuthored,
        browserNavigation: isBrowserNavigation(incomingHeaders),
      })
    ) {
      const resumeExternalId = record.externalId;
      await resumeStoppedSandboxByExternalId(resumeExternalId).catch((err) => {
        console.warn(`[sandbox-proxy] auto-resume failed for ${resumeExternalId}:`, err);
        return false;
      });
      // Re-read: the resume flips the row → 'active' (this call or a concurrent
      // one). The box boots in the background; the wake/retry loop below tolerates
      // the gap and forwards once it's up (and subsequent client retries recover).
      const resumed = await loadSandbox(sandboxId);
      if (resumed) record = resumed;
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
  }
  const serviceKey = record.serviceKey;

  // OBSERVE THE TURN START **BEFORE** FORWARDING IT.
  //
  // Two reasons this is here and awaited rather than fire-and-forget after the
  // response, which is where it used to be:
  //
  //  1. At the 24-hour absolute run cap the grant clamps to `active_since + 24h`
  //     — already in the past — so the old ordering ACCEPTED the prompt and let
  //     the reaper stop the box seconds later, mid-work, swallowing the user's
  //     message. Accepting work you are about to kill is worse than refusing it.
  //     Refuse, park the box so the retry re-anchors a fresh stretch, and say so
  //     in a machine-readable body.
  //  2. Before the dedupe claim, so a refusal does not burn the caller's
  //     Idempotency-Key and turn their retry into a bogus 200 "duplicate".
  //
  // A lost/failed observation fails OPEN (see observeTurnStart) — the deadline is
  // still bounded by the DB CHECK, and refusing a prompt on uncertainty is far
  // worse than granting one turn too many.
  if (!sandboxAuthored && isTurnStartRequest(upstreamPort, method, remainingPath)) {
    const observed = await observeTurnStart({ externalId: sandboxId });
    if (observed === 'at_cap') {
      const capped = {
        sandboxId: record.sandboxId,
        sessionId: record.sessionId,
        externalId: record.externalId,
        provider: record.provider as ProviderName,
      };
      // Dynamic import: the reaper's stop path reaches back into this module's
      // own package (invalidateProviderCache), and a static edge here would be a
      // real cycle. This branch is rare by construction — once per 24h of
      // continuous work — so the one-time load cost is irrelevant.
      void import('../../projects/reaping/stop-box')
        .then((m) => m.parkBoxAtRunCap(capped))
        .catch((err) =>
          console.warn(
            `[deadline] run-cap park could not be scheduled for ${sandboxId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      console.warn(`[PREVIEW] Refused turn on sandbox ${sandboxId}: 24h run cap reached`);
      return jsonProxyError(
        {
          error: 'This sandbox has reached its 24-hour continuous run limit and is restarting.',
          code: 'sandbox_run_cap_reached',
          retry: true,
        },
        503,
        origin,
      );
    }
  }

  // Dedupe prompt delivery up-front. REST and ACP prompt POSTs are the only
  // mutating, non-idempotent calls here. Claim a stable key before the retry
  // loop so a duplicate inbound prompt cannot enqueue the user message twice.
  //
  // The key is held in an OUTER binding so the give-up path below can release it
  // when delivery provably never happened. Without that release, a client retry
  // under the same Idempotency-Key hits the bogus 200 "duplicate" and the user's
  // prompt is silently lost.
  let promptDedupeKey: string | null = null;
  if (promptDelivery) {
    promptDedupeKey = promptDeliveryKey({
      idempotencyKey: incomingHeaders.get('idempotency-key'),
      sandboxId,
      sessionId: record.sessionId,
      body,
    });
    if (!claimPromptDelivery(promptDedupeKey)) {
      return jsonProxyError({ status: 'duplicate', deduplicated: true }, 200, origin);
    }
  }

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
  // False until this request reaches the non-idempotent upstream prompt fetch.
  // Pre-prompt failures, such as env synchronization, are safe to retry.
  let promptDeliveryMayHaveReachedUpstream = false;
  // A blocking session-turn (`POST /session/:id/message`) whose single attempt
  // (it gets ~the whole remaining budget, see proxyAttemptTimeoutMs) still hit
  // the connect-timer. That's a legitimately long-running, healthy turn, not a
  // stalled connection — see the giveup branch below for why it gets its own
  // response instead of the generic "sandbox unreachable" one.
  let sawLongTurnTimeout = false;
  // A prompt delivery whose failure is AMBIGUOUS — a timeout/abort/reset where
  // opencode may already hold the message. When true we must NOT release the
  // dedupe claim on the unreachable path below (a retry could double-enqueue).
  // It stays false only when every attempt PROVED nothing was delivered
  // (connection refused), which is the one case a retry may safely re-deliver.
  let promptDeliveryMaybeAccepted = false;

  // Wall-clock budget so a cold/dead sandbox returns our friendly page BEFORE
  // the 60s ALB idle timeout severs the connection (→ Cloudflare's bare 502).
  const proxyStartedAt = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const budgetRemainingMs = PROXY_RETRY_BUDGET_MS - (Date.now() - proxyStartedAt);
    if (budgetRemainingMs <= 500) break; // out of budget → friendly page below
    try {
      const ingress = await resolveSandboxIngress(record, ingressRequest);
      const previewUrl = ingress.url;
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
          return agentSwitchConflictResponse(sessionAgent, requestedAgent!, origin);
        }
        // AUTHORIZE the agent this prompt will run — before the env sync, before
        // the re-mint, before the title/snapshot side effects.
        //
        // `project.agent.read` was asserted ONCE, at session create, against
        // `body.agent_name` (projects/routes/r7.ts). The prompt path never
        // re-checked, so a member scoped to agent A only could create the session
        // as A and then prompt `{"agent":"B"}` — and be HANDED B's grant by the
        // re-mint below, which re-scopes the token to whatever agent is named.
        // `remintDecisionFor` refuses only the fully-null UNRESTRICTED widening;
        // it was never an authorization gate and cannot serve as one.
        //
        // Costs nothing on an ordinary turn: only a CONCRETE agent differing from
        // the session's is a switch (the 'default' sentinel is non-binding on
        // either side — see isProhibitedAgentSwitch).
        const switchedToAgent = isProhibitedAgentSwitch(requestedAgent, sessionAgent)
          ? requestedAgent
          : null;
        if (switchedToAgent) {
          const verdict = await authorize(
            userId,
            record.accountId,
            PROJECT_ACTIONS.PROJECT_AGENT_READ,
            {
              type: 'project',
              id: record.projectId,
              resource: { type: 'agent', id: switchedToAgent },
            },
          );
          if (!verdict.allowed) {
            console.warn(
              `[PREVIEW] Refused prompt on ${sandboxId}: caller may not run agent '${switchedToAgent}' (${verdict.reason})`,
            );
            return jsonProxyError(
              {
                error: `You don't have permission to run the agent '${switchedToAgent}'.`,
                code: 'AGENT_NOT_AUTHORIZED',
                requested_agent: switchedToAgent,
              },
              403,
              origin,
            );
          }
        }
        // Drop only the legacy 'default' sentinel so OpenCode resolves its own
        // `default_agent` (the real default the session booted with). A *concrete*
        // requested agent is forwarded untouched so the user can switch agents
        // within a session.
        if (requestedAgent === DEFAULT_AGENT_SENTINEL) {
          body = bodyWithoutPromptAgent(body, incomingHeaders);
        }
        // A prompt is the one moment this sandbox is guaranteed awake, so off
        // it we (1) generate the Kortix-owned session title from this first
        // prompt, using the model the user picked, and (2) refresh the
        // opencode_sessions snapshot the conversation list reads. Both are
        // fire-and-forget and never block the prompt.
        const prompt = extractPromptInfo(body, incomingHeaders);
        if (userId && prompt.text) {
          void generateSessionTitleFromFirstPrompt({
            sessionId: record.sessionId,
            projectId: record.projectId,
            accountId: record.accountId,
            userId,
            firstPromptText: prompt.text,
            modelHint: prompt.model ?? undefined,
          });
        }
        scheduleOpencodeSnapshotSync({
          sessionId: record.sessionId,
          projectId: record.projectId,
          externalId: record.externalId,
        });
        try {
          await syncSandboxEnvForPrompt({
            projectId: record.projectId,
            sessionId: record.sessionId,
            serviceKey,
            previewUrl,
            providerHeaders: ingress.headers,
            providerName: record.provider as ProviderName,
            // The secret grant is resolved from the agent this prompt actually
            // runs, not the session's create-time column — see
            // projects/lib/secret-grant.ts.
            requestedAgent,
          });
          // The env sync above already refused a secret-boundary switch, so
          // reaching here means the switch is legal. Re-point the token's
          // connector/CLI grant at the agent that will actually run — it was
          // frozen at mint from the BOOT agent, and those gates read it at call
          // time. Only on a real switch: an ordinary turn resolves to the
          // session's own agent and skips the manifest read entirely.
          await remintGrantForAgentSwitch({
            projectId: record.projectId,
            sessionId: record.sessionId,
            sessionAgent,
            requestedAgent,
          });
        } catch (err) {
          // Fail closed on anything to do with the secret grant: refuse the
          // prompt rather than forwarding it against an env we can't vouch for.
          const grantResponse = secretGrantErrorResponse(err, origin);
          if (grantResponse) {
            console.warn(
              `[PREVIEW] Secret grant refused prompt for ${sandboxId}:${port}: ${errorMessage(err, 'secret grant error')}`,
            );
            return grantResponse;
          }
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
          return jsonProxyError({ error: message }, 502, origin);
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
        providerHeaders: ingress.headers,
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

      // Bound a wedged first connection to a freshly-restored microVM (residual
      // CH RX stall) so the attempt fails fast → retry on a fresh connection,
      // instead of hanging the whole proxy. `body` is buffered (line ~576, not
      // a stream) so aborting only kills the in-flight attempt, never truncates
      // an upload mid-stream.
      //
      // CRITICAL: for ordinary requests the timeout bounds ONLY the
      // connect/header phase — the timer is cleared the moment `fetch` resolves.
      // Multipart uploads are the exception: their handler cannot return
      // headers until the body is written, so they receive the remaining outer
      // proxy budget instead of the generic 15s cutoff. The previous
      // `AbortSignal.timeout(...)` bounded the ENTIRE fetch lifecycle, which
      // severed every streaming response body at ~15s: the `/global/event` SSE
      // stream (each open session tab then reconnected ~250ms later, forever —
      // a fleet-wide reconnect storm, ~240 reconnects/hour/tab), long-polls,
      // and any proxied download slower than 15s. The retry loop only ever
      // needed to retry attempts whose CONNECTION wedged, which this still does.
      const attemptController = new AbortController();
      const connectTimer = setTimeout(
        () =>
          attemptController.abort(
            new DOMException('proxy attempt connect timeout', 'TimeoutError'),
          ),
        proxyAttemptTimeoutMs(budgetRemainingMs, retryBudgetRequest),
      );
      let upstream: Response;
      try {
        if (promptDelivery) promptDeliveryMayHaveReachedUpstream = true;
        upstream = await fetch(targetUrl, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: attemptController.signal,
          // Bun extensions: no decompression (raw byte passthrough), duplex streaming —
          // not in the lib RequestInit type.
          decompress: false,
          duplex: 'half',
        } as RequestInit);
      } finally {
        clearTimeout(connectTimer);
      }

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
        return jsonProxyError({ error: 'sandbox proxy authentication rejected' }, 502, origin);
      }

      // Daytona returns various error codes when the sandbox isn't ready:
      //   400 "no IP address found" — sandbox is stopped
      //   400 "failed to get runner info" — sandbox is archived (no runner)
      //   502 — container started but the port isn't listening yet
      //   503 — sandbox service temporarily unavailable
      // Retry with auto-wake so users don't see errors during the boot window.
      if (upstream.status === 503) {
        const bodyText = await upstream
          .clone()
          .text()
          .catch(() => '');
        if (bodyText.includes('opencode not ready')) {
          void markSandboxUsed(sandboxId);
          // opencode explicitly rejected the request as not-ready, so it did NOT
          // enqueue the prompt. Release the dedupe claim so the client's retry
          // (once opencode is up) actually delivers instead of short-circuiting
          // to a bogus 200 "duplicate" that would drop the message.
          if (promptDedupeKey) releasePromptDelivery(promptDedupeKey);
          const notReadyHeaders = clientResponseHeaders(upstream.headers, origin);
          return new Response(bodyText, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: notReadyHeaders,
          });
        }
      }

      if (upstream.status === 502 || upstream.status === 503) {
        // A prompt-delivery POST is NEVER retried on a 5xx: an upstream 502 can
        // mean the sandbox already accepted the message (the gateway just dropped
        // the response), so re-POSTing would enqueue it twice. Pass the upstream
        // response straight through to the passthrough below. GET/idempotent
        // requests retry as before.
        if (!promptDelivery && attempt < MAX_RETRIES) {
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
        if (!promptDelivery && isBrowserNavigation(incomingHeaders)) {
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

      if (upstream.status === 400) {
        const bodyText = await upstream.text();
        const isSandboxDown =
          bodyText.includes('no IP address found') ||
          bodyText.includes('failed to get runner info');
        // Daytona rejected this BEFORE opencode — the box has no runner, so the
        // prompt certainly was not enqueued. On the last attempt we stop
        // retrying and pass the 400 through, and the dedupe claim must go with
        // it: otherwise the client's retry under the same Idempotency-Key hits
        // the bogus 200 "duplicate" and the message is lost. (Reviewer caught
        // this: the retry guard used to be part of THIS condition, so the final
        // attempt fell through holding the claim.)
        if (isSandboxDown && attempt >= MAX_RETRIES && promptDedupeKey) {
          releasePromptDelivery(promptDedupeKey);
        }
        if (isSandboxDown && attempt < MAX_RETRIES) {
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
      // A HUMAN IS USING THIS BOX'S PREVIEW. The turn-start observation already
      // happened before the forward (see above); this is the other
      // control-plane-observed signal: an authenticated account member driving
      // the dev server the agent just built. The API watched the whole request,
      // so it cannot be forged by the box, and without it a user clicking through
      // their own app watched it die 15 minutes after the last AGENT turn — a
      // worse regression than the zombie boxes this design deletes.
      //
      // Throttled to one write per minute per box: a page load is 200 requests
      // and every extend is monotone, so the other 199 would land on the value
      // the first already produced.
      if (
        upstream.ok &&
        isPreviewUseObservation({
          isPrincipal: access.kind === 'principal',
          sandboxAuthored,
          upstreamPort,
        }) &&
        previewUseThrottle.take(sandboxId)
      ) {
        void extendSandboxDeadline({ externalId: sandboxId }, previewGrantMs()).catch((err) =>
          console.warn(
            `[deadline] preview-use extend failed for sandbox ${sandboxId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
      if (acpPromptSession && upstream.ok) {
        const prompt = extractPromptInfo(body, incomingHeaders);
        if (userId && prompt.text) {
          void generateSessionTitleFromFirstPrompt({
            sessionId: record.sessionId,
            projectId: record.projectId,
            accountId: record.accountId,
            userId,
            firstPromptText: prompt.text,
            modelHint: prompt.model ?? undefined,
          });
        }
        scheduleOpencodeSnapshotSync({
          sessionId: record.sessionId,
          projectId: record.projectId,
          externalId: record.externalId,
          userId: userId || undefined,
        });
      }
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

      // A connect-timer abort on a long-turn completion request means the
      // upstream was still actively computing when its (near-full-budget)
      // attempt ran out of room — not that it's stalled or dead. Waking an
      // already-healthy sandbox is a no-op-but-wasted provider call, and
      // retrying would resubmit the user's message a second time (this
      // endpoint isn't idempotent). Stop here and report it honestly instead.
      if (
        err instanceof DOMException &&
        err.name === 'TimeoutError' &&
        isLongTurnCompletionRequest(retryBudgetRequest)
      ) {
        sawLongTurnTimeout = true;
        break;
      }

      // A prompt-delivery POST must NOT be blindly retried on an ambiguous
      // failure: a timeout / abort / connection reset can mean the sandbox
      // already received and accepted the message, so re-POSTing would enqueue
      // it twice. Only retry when the error PROVES nothing reached the box (the
      // upstream refused the connection). Any other error stops here and returns
      // the friendly unreachable response below. (The Daytona "no IP / no runner"
      // 400 branch — a rejection before opencode — retries in the response path
      // above, which is safe.)
      if (
        promptDeliveryMayHaveReachedUpstream &&
        promptDelivery &&
        !isConnectionRefusedError(err)
      ) {
        // Ambiguous: the box may already hold the message. Keep the dedupe
        // claim so a client retry can't double-enqueue.
        promptDeliveryMaybeAccepted = true;
        break;
      }

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

  if (sawLongTurnTimeout) {
    return longTurnTimeoutResponse(origin);
  }

  // All retries exhausted. Only error the row when the provider CONFIRMED the
  // sandbox is dead — never on a transient unreachable / RX stall, which would
  // flip a health-green box to 'error' (the chat-failed + session-list-lag bug,
  // 2026-06-14). When not confirmed-dead, fail just this request gracefully; the
  // health-check loop owns liveness and will retry the box.
  if (sawDeadSignal) {
    await markSandboxErrored(sandboxId);
  }
  // The sandbox was never reachable. For a prompt delivery this path is only
  // taken after every attempt PROVED nothing was delivered (connection refused,
  // or out of budget before a second try) — an ambiguous 5xx/timeout/reset would
  // have returned above with the claim intact. So release the dedupe claim to let
  // the client's retry actually deliver, instead of losing the message to a
  // bogus 200 "duplicate".
  if (promptDedupeKey && !promptDeliveryMaybeAccepted) {
    releasePromptDelivery(promptDedupeKey);
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
  /** The caller's own session when the credential is bound to one, or null for a
   *  principal that is not session-bound. REQUIRED — fail closed, never default. */
  callerSessionId: string | null;
}): Promise<
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; status: number; message: string }
> {
  const { sandboxId, userId, remainingPath, queryString } = opts;
  const callerSessionId = opts.callerSessionId;

  const record = await loadSandbox(sandboxId);
  if (!record) return { ok: false, status: 404, message: 'sandbox not found' };

  const ingressRequest = {
    port: opts.upstreamPort,
    path: remainingPath,
    transport: 'websocket' as const,
  };
  const upstreamPort = routeSandboxIngress(record, ingressRequest).effectivePort;

  if (!(await canAccessPreviewSandbox({ previewSandboxId: sandboxId, userId }))) {
    return { ok: false, status: 403, message: 'not authorized' };
  }
  // Both session-data ports carry the conversation — gate on session visibility,
  // not just account membership (see forwardToSandbox). This resolver forces
  // opencode WebSockets to :4096 on Daytona, so keying on 8000 alone left the
  // PTY/opencode WS leg ungated there — the same hole this PR closes on the HTTP
  // side, one function further down the file.
  if (
    carriesSessionData(upstreamPort) &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      callerSessionId: callerSessionId ?? null,
    }))
  ) {
    return { ok: false, status: 403, message: 'not authorized for this session' };
  }
  if (record.status !== 'active') {
    return { ok: false, status: 503, message: 'sandbox not ready' };
  }

  const ingress = await resolveSandboxIngress(record, ingressRequest);
  const previewUrl = ingress.url;
  const wsBase = previewUrl
    .replace(/\/$/, '')
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:');
  const headers = await buildSandboxUpstreamHeaders({
    sandboxId,
    userId,
    serviceKey: record.serviceKey,
    providerHeaders: ingress.headers,
  });

  const upstreamUrl = new URL(wsBase + remainingPath + queryString);
  if (ingress.websocket?.userContextQueryParam) {
    const signedContext = headers[KORTIX_USER_CONTEXT_HEADER];
    if (signedContext) {
      upstreamUrl.searchParams.set(ingress.websocket.userContextQueryParam, signedContext);
    }
  }
  for (const [key, value] of Object.entries(ingress.websocket?.queryDefaults ?? {})) {
    if (!upstreamUrl.searchParams.has(key)) upstreamUrl.searchParams.set(key, value);
  }

  return { ok: true, url: upstreamUrl.toString(), headers };
}

// === Route handlers: ALL /:sandboxId/:port(/*) ===
//
// Thin wrappers around forwardToSandbox — extract params from the Hono context.

preview.all('/:sandboxId/:port/*', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const portStr = c.req.param('port');
  const port = Number.parseInt(portStr, 10);

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
    sandboxId,
    port,
    {
      kind: 'principal',
      userId,
      callerSessionId: c.get('sessionId') ?? null,
      // `callerKortixSessionId`, NEVER the raw context var. `combinedAuth`'s
      // local JWT fast path leaves `sessionId` unset for a browser, but its
      // NETWORK-FALLBACK branch (taken whenever JWKS has not warmed, and
      // permanently if JWKS resolution is broken) sets it to the SUPABASE AUTH
      // SESSION id. Reading it raw made every human in that window look
      // sandbox-authored: no turn-start extend, no preview-use extend, and no
      // auto-resume of a parked box from the UI.
      sandboxAuthored: isSandboxAuthored(c.get('apiKeyType'), callerKortixSessionId(c)),
    },
    method,
    remainingPath,
    queryString,
    c.req.raw.headers,
    body,
    origin,
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
