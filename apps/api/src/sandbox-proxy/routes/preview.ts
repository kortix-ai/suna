import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { config } from '../../config';
import { PROJECT_ACTIONS, authorize } from '../../iam';
import { actorForUser } from '../../iam/actor';
import { getTraceHeaders, setContextField } from '../../lib/request-context';
import { timeUpstream } from '../../middleware/upstream-timing';
import { classifyPtyWebSocketPath } from '../../platform/providers/pty-ingress';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { callerKortixSessionId } from '../../projects/lib/caller-session';
import {
  PromptConnectorPreflightUnresolved,
  type PromptConnectorVerdict,
  missingPromptConnectorConnections,
} from '../../projects/lib/prompt-connector-preflight';
import { syncSessionRuntimesEnvForPrompt } from '../../projects/lib/sandbox-env-sync';
import { remintGrantForAgentSwitch } from '../../projects/lib/session-token-grant';
import { scheduleOpencodeSnapshotSync } from '../../projects/opencode-session-snapshot';
import { resumeStoppedSandboxByExternalId } from '../../projects/routes/shared';
import {
  createExtendThrottle,
  extendSandboxDeadline,
  isPreviewUseObservation,
  isSandboxAuthored,
  isTurnStartRequest,
  previewGrantMs,
} from '../../projects/sandbox-deadline';
import {
  abandonSandboxTurn,
  acceptSandboxTurn,
  beginSandboxTurn,
  extractTurnIdentity,
} from '../../projects/sandbox-turn-lifecycle';
import { recordSessionActivity } from '../../projects/session-activity';
import { generateSessionTitleFromFirstPrompt } from '../../projects/session-title-generate';
import {
  KORTIX_SERVICE_CALL_HEADER,
  KORTIX_USER_CONTEXT_HEADER,
} from '../../shared/kortix-user-context';
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
import { stripInlineAttachmentBytes } from '../inline-attachments';
import {
  DEFAULT_AGENT_SENTINEL,
  type PrePromptEnvSyncDeps,
  bodyWithoutPromptAgent,
  errorMessage,
  jsonProxyError,
  requestedPromptAgent,
  runPrePromptEnvSync,
  secretGrantErrorResponse,
  shouldSyncProjectEnvBeforeProxy,
} from '../pre-prompt-env-sync';
import { previewCorsHeaders } from '../preview-hosts';
import {
  PROXY_RETRY_BUDGET_MS,
  isLongTurnCompletionRequest,
  isUploadRequest,
  proxyAttemptTimeoutMs,
} from '../preview-retry-budget';
import { appCookieHeader } from '../preview-session';
import { PREVIEW_STATE_HEADER, type PreviewState, previewStatePage } from '../preview-state-page';
import {
  claimPromptDelivery,
  isNonIdempotentSessionWrite,
  promptDeliveryKey,
  releasePromptDelivery,
  shouldClaimPromptDelivery,
} from '../prompt-dedupe';
import {
  EFFECTIVE_MESSAGE_ID_HEADER,
  PROMPT_TRANSCRIPT_READ_LIMIT,
  WIRE_ID_PLACED_HEADER,
  isPromptWireIdRepairPath,
  promptBodyMessageId,
  promptTranscriptReadPath,
  readNewestWireIdTime,
  repairPromptWireId,
} from '../prompt-wire-id-repair';
import {
  PROXY_HOP_HEADER,
  PROXY_UPSTREAM_STATUS_HEADER,
  type ProxyHop,
  portFailureHop,
} from '../proxy-hop';
import { carriesSessionData, requiresSessionVisibility } from '../session-data-ports';
import { recordSseStreamEnd, shouldBypassIngressCache, trackSseBytes } from '../sse-stall';

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
// Accept-Encoding is forced to identity (raw byte passthrough) EXCEPT on the
// paths named by `forwardsClientEncoding` below.
// Cookies may contain the caller's raw __preview_session credential and must
// never reach arbitrary user-controlled apps running inside the sandbox.
// `x-kortix-service-call` marks a DIRECT platform→daemon call. The daemon gates
// its destructive branch reset on it precisely because it cannot appear here:
// we authenticate every forwarded request with the sandbox's own service key, so
// the daemon cannot tell a user's request from ours by the bearer alone. Strip
// it for the same reason we strip `authorization` — a caller must not be able to
// hand themselves platform authority by naming a header.
export const STRIP_FORWARD_HEADERS = new Set([
  'x-kortix-wire-id-placed',
  'host',
  'authorization',
  'cookie',
  'traceparent',
  'x-request-id',
  'accept-encoding',
  'content-length',
  KORTIX_SERVICE_CALL_HEADER.toLowerCase(),
]);

/**
 * Which upstream paths get the CLIENT's `Accept-Encoding` instead of `identity`.
 *
 * Identity is the right default and stays the default: this proxy REWRITES some
 * bodies on the way back (`stripInlineAttachmentBytes` does `await
 * upstream.text()` on a transcript list), and a rewriter handed gzip bytes
 * produces garbage. Forcing identity is what makes that safe without every
 * future rewrite having to remember to decompress.
 *
 * The daemon's `/kortix/opencode/*` namespace is the exception, and it earns it:
 *   • nothing on this proxy rewrites those bodies — the projection is already
 *     the trimmed shape, so there is nothing left to strip;
 *   • the whole point of the namespace is byte reduction across THIS hop.
 *     `/kortix/opencode/state` is 8.7 KB raw and 0.9 KB gzipped (WS-Z1 §5);
 *     forcing identity here would throw away 90% of the saving before the
 *     response ever reaches the API's own compressor.
 *
 * `/events` is excluded even inside that namespace: the daemon never gzips an
 * event stream, and asking it to would be asking for a buffered one.
 */
export function forwardsClientEncoding(port: number, remainingPath: string): boolean {
  if (port !== 8000) return false;
  if (!/^\/kortix\/opencode(?:$|\/)/.test(remainingPath)) return false;
  return !/^\/kortix\/opencode\/events(?:$|[/?#])/.test(remainingPath);
}

// The pre-prompt turn-start gate lives in ../pre-prompt-env-sync.ts so a unit
// test can reach it without evaluating this route — importing this file caches
// its collaborators and silently disables every sibling suite's `mock.module`
// (see the header comment there). Re-exported so existing import paths, and the
// suites that already read these names off `./preview`, keep working.
export {
  bodyWithoutPromptAgent,
  requestedPromptAgent,
  runPrePromptEnvSync,
  secretGrantErrorResponse,
  shouldSyncProjectEnvBeforeProxy,
} from '../pre-prompt-env-sync';
export type { PrePromptEnvSyncDeps } from '../pre-prompt-env-sync';

// One deadline write per minute per box for HUMAN preview traffic. Mirrors
// SANDBOX_TOUCH_INTERVAL_MS in ../backend.ts, for the same reason: a single page
// load is hundreds of requests and the extend is monotone, so collapsing them
// loses nothing.
const previewUseThrottle = createExtendThrottle(60_000);

/**
 * Bind the provider-facing sandbox identifier to its canonical Kortix scope.
 * The request audit middleware runs after the proxy handler returns and reads
 * this request-local context. Without this binding, `/v1/p/...` activity is
 * present only in the account log and disappears from project/session history.
 */
export function bindSandboxRequestContext(
  record: { accountId: string; projectId: string; sessionId: string },
  sandboxId: string,
): void {
  setContextField('accountId', record.accountId);
  setContextField('projectId', record.projectId);
  setContextField('sessionId', record.sessionId);
  setContextField('sandboxId', sandboxId);
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
// Framing is intentionally OPEN, and that is not the same as unprotected. The
// credential is now an ambient `SameSite=None` cookie, so any site can frame a
// signed-in user's live preview — what stops that being useful is the
// cross-site gate in preview-origin.ts (reads are governed by the CORS
// allowlist, writes and WebSocket upgrades require a same-site Sec-Fetch-Site),
// not a framing restriction.
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
  // One allowlist for both edges — see previewCorsHeaders. An arbitrary origin
  // gets nothing, because the preview cookie is ambient on cross-site requests.
  for (const [key, value] of Object.entries(previewCorsHeaders(origin))) {
    headers.set(key, value);
  }

  // The app inside the sandbox writes its own cookies, and they are forwarded —
  // that is what makes a cookie-session app work. What it may NOT do is widen
  // their scope: `p.kortix.com` is not on the Public Suffix List, so a
  // `Domain=kortix.com` cookie from a preview would be accepted for the web app
  // and the API too. Strip `Domain` (leaving a host-only cookie, which is what
  // the app actually needs) and drop any attempt to overwrite ours.
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length) {
    headers.delete('set-cookie');
    for (const cookie of setCookies) {
      const name = cookie.split('=', 1)[0]?.trim();
      if (name === '__kortix_preview' || name === '__kortix_preview_chips') continue;
      headers.append(
        'set-cookie',
        cookie
          .split(';')
          .filter((attr) => !/^\s*domain\s*=/i.test(attr))
          .join(';'),
      );
    }
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

/**
 * The address the browser is on, reconstructed from the request it sent. Shown
 * on the state page and carried into the sign-in hand-off. Falls back to '' when
 * the headers do not say, which simply omits it from the page.
 */
function previewReturnTo(incomingHeaders: Headers): string {
  const forwarded =
    incomingHeaders.get('x-kortix-preview-host') || incomingHeaders.get('x-forwarded-host');
  const host = forwarded || incomingHeaders.get('host') || '';
  if (!host) return '';
  const proto = incomingHeaders.get('x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}

// Response for an unreachable / not-yet-ready sandbox port: a friendly HTML page
// for browser navigations, machine-readable JSON otherwise. Marked no-store so a
// retry always re-hits the upstream instead of a cached error.
//
// `hop` is mandatory: the status alone cannot distinguish a parked row from a
// dead runtime from a dev server the agent never started, and a caller that has
// to guess guesses wrong (see `proxy-hop.ts`). `upstreamStatus` is the status
// the failing hop actually returned, when there was one — a thrown/refused
// connection has none.
export function portUnreachableResponse(opts: {
  port: number;
  status: number;
  origin: string;
  incomingHeaders: Headers;
  reason: string;
  hop: ProxyHop;
  upstreamStatus?: number | null;
  // Stable machine code for the failure class (e.g. 'sandbox_not_ready'), so
  // clients branch on a code instead of matching the human-readable `reason`.
  code?: string;
  // True when the failure is transient by design (a parked/booting box) and a
  // retry of the same request is expected to succeed once the box is up.
  retry?: boolean;
}): Response {
  const { port, status, origin, incomingHeaders, reason, hop, code, retry } = opts;
  const upstreamStatus = opts.upstreamStatus ?? null;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  // Set on EVERY variant, HTML included: a `fetch` probe that lands on the
  // browser-navigation branch (it sends `Accept: text/html`) must still be able
  // to attribute the failure.
  headers.set(PROXY_HOP_HEADER, hop);
  if (upstreamStatus !== null) {
    headers.set(PROXY_UPSTREAM_STATUS_HEADER, String(upstreamStatus));
  }
  // The SAME allowlist as every other preview response — this was a third copy
  // of the policy and it still echoed any origin back with credentials.
  const cors = previewCorsHeaders(origin);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  if (Object.keys(cors).length) {
    // Without this the browser hides both headers from JS and the probe is back
    // to guessing — the web app and the API are always different origins.
    headers.set(
      'Access-Control-Expose-Headers',
      `${PROXY_HOP_HEADER}, ${PROXY_UPSTREAM_STATUS_HEADER}`,
    );
  }
  if (isBrowserNavigation(incomingHeaders)) {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    // A browser gets 200 and a page it can read, NOT the 5xx.
    //
    // "The dev server has not bound the port yet" and "the box is still waking"
    // are the ordinary first seconds of a preview, not gateway failures — and
    // reporting them as 5xx meant this page never arrived: Cloudflare replaces
    // an origin 5xx with its own branded error interstitial (proved by the
    // absence of x-kortix-proxy-hop on what reached the client). The real state
    // stays fully legible — the status is still on every non-navigation
    // response, and both hop headers are set here too, so a fetch probe reads
    // exactly what it always did.
    const state: PreviewState =
      code === 'sandbox_not_ready' || retry === true
        ? 'starting'
        : upstreamStatus === null
          ? 'not-listening'
          : 'unreachable';
    headers.set(PREVIEW_STATE_HEADER, state);
    return new Response(
      previewStatePage({
        state,
        port,
        returnTo: previewReturnTo(incomingHeaders),
        frontendUrl: config.FRONTEND_URL || '',
      }),
      { status: 200, headers },
    );
  }
  headers.set('Content-Type', 'application/json');
  return new Response(
    JSON.stringify({
      error: reason,
      port,
      status,
      hop,
      upstream_status: upstreamStatus,
      ...(code ? { code } : {}),
      ...(retry !== undefined ? { retry } : {}),
    }),
    {
      status,
      headers,
    },
  );
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
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
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

// True only when a fetch failure PROVES nothing reached the box: the upstream
// actively refused the connection (nothing was ever accepted). Any other thrown
// error — timeout, abort, connection reset mid-flight — is ambiguous: the
// sandbox may already have received and accepted the prompt, so a re-send would
// duplicate it. Used to gate the one safe prompt-delivery retry in the catch.
function isConnectionRefusedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
  };
  const codes = [e.code, e.cause?.code].filter((c): c is string => typeof c === 'string');
  if (codes.some((c) => c === 'ECONNREFUSED')) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /econnrefused|connection refused|failed to connect|unable to connect/i.test(message);
}

/**
 * Does this request START A USER TURN that a missing connector should block?
 *
 * The same shape as `isTurnStartRequest` MINUS `/summarize`. Summarize is
 * compaction, not a user turn: refusing to compact a conversation because Gmail
 * is disconnected would wedge the session instead of protecting it.
 *
 * Built on `isTurnStartRequest` rather than the env-sync predicate
 * (`shouldSyncProjectEnvBeforeProxy`) because that one keys on the
 * client-addressed port, so a request sent straight to :4096 slips past it, and
 * it does not strip the in-box `/proxy/{port}` prefix.
 */
function isConnectorGatedTurn(port: number, method: string, path: string): boolean {
  if (!isTurnStartRequest(port, method, path)) return false;
  return !/^\/session\/[^/]+\/summarize(?:$|[/?#])/.test(path.replace(/^\/proxy\/\d+(?=\/)/, ''));
}

/**
 * May this caller run the agent this prompt names? Response to refuse, or null.
 *
 * Hoisted out of the forward loop so it runs BEFORE the connector gate. The
 * connector gate reads the requested agent's manifest, and a caller who may not
 * run agent B must not learn which connectors B requires by naming it — the
 * refusal list carries connector ids, names and strategies.
 *
 * Running it here also fixes a defect it had where it sat: below
 * `claimPromptDelivery`, so a 403 burned the Idempotency-Key and the retry after
 * being granted access came back as a silent duplicate.
 */
async function agentSwitchRefusal(
  record: { accountId: string; projectId: string; agentName?: string | null },
  requestedAgent: string | null,
  userId: string | undefined,
  sandboxId: string,
  origin?: string,
): Promise<Response | null> {
  const sessionAgent = record.agentName ?? DEFAULT_AGENT_SENTINEL;
  // In-session agent switching is allowed, unconditionally. What remains is an
  // AUTHORIZATION question, not an immutability one: may THIS caller run THAT
  // agent? The grant the switched-to agent runs under is re-scoped separately
  // (env sync + token re-mint) before the prompt is forwarded.
  if (!isConcreteAgentSwitch(requestedAgent, sessionAgent)) return null;
  const switchedToAgent = requestedAgent as string;
  if (!userId) {
    // A switch is an authorization decision and there is no principal to decide
    // about — a share-token forward, say. Refuse rather than run another agent
    // on nobody's authority.
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

  // No Hono context here — this runs inside the proxy forward loop, whose only
  // identity is the resolved `userId`. The question is an OBJECT-grant one
  // ("is this agent scoped to you"), which no credential can widen, so the
  // role-only actor is the same authority this call already had.
  const verdict = await authorize(
    actorForUser(userId, record.accountId),
    PROJECT_ACTIONS.PROJECT_AGENT_READ,
    {
      type: 'project',
      id: record.projectId,
      resource: { type: 'agent', id: switchedToAgent },
    },
  );
  if (verdict.allowed) return null;
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

/**
 * The refusal body, or null to let the turn through.
 *
 * The shape is byte-identical to what session CREATE returns for the same two
 * codes (projects/routes/project-sessions.ts). That is a contract, not a coincidence: one
 * client classifier has to read both, and a renamed field here degrades to a
 * card that says "a connector is missing" without naming which.
 */
async function connectorGateRefusal(
  record: {
    accountId: string;
    projectId: string;
    sessionId: string;
    agentName?: string | null;
  },
  requestedAgent: string | null,
  origin?: string,
): Promise<Response | null> {
  let verdict: PromptConnectorVerdict;
  try {
    verdict = await missingPromptConnectorConnections({
      accountId: record.accountId,
      projectId: record.projectId,
      sessionId: record.sessionId,
      sessionAgent: record.agentName ?? DEFAULT_AGENT_SENTINEL,
      requestedAgent,
    });
  } catch (err) {
    if (err instanceof PromptConnectorPreflightUnresolved) {
      // 503, never 409. We failed to ESTABLISH the answer; saying "connect your
      // Gmail" off a transient git read would be a confident lie, and the client
      // retries a 503 while it never retries a 4xx.
      console.warn(
        `[PREVIEW] Connector pre-flight unresolved for ${record.sessionId}: ${err.message}`,
      );
      return jsonProxyError(
        { error: err.message, code: 'CONNECTOR_REQUIREMENTS_UNRESOLVED' },
        503,
        origin,
      );
    }
    throw err;
  }
  if (verdict.ok) return null;

  if (verdict.kind === 'unavailable') {
    return jsonProxyError(
      {
        error:
          verdict.aliases.length === 1
            ? `Required connection "${verdict.aliases[0]}" is unavailable`
            : `Required connections ${verdict.aliases.map((a) => `"${a}"`).join(', ')} are unavailable`,
        code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
        connectors: verdict.aliases,
      },
      409,
      origin,
    );
  }
  return jsonProxyError(
    {
      // `message` as well as `error`: the SDK prefers `message` and otherwise
      // substitutes a generic "Failed to send message", which would bury this.
      error: 'Create the required connections before continuing this session.',
      message: 'Create the required connections before continuing this session.',
      code: 'CONNECTOR_CONNECTION_REQUIRED',
      connector_connections: verdict.connections,
    },
    409,
    origin,
  );
}

// A prompt's explicit `agent` only constitutes a prohibited switch when it would
// run a DIFFERENT *concrete* agent than the one this session's connector token was
// minted for. That — and only that — is the escalation the policy prevents (see
// docs/specs/2026-06-28-token-session-agent-identity.md). The sentinel 'default'
// is non-binding on EITHER side: a session stored as 'default' has no privileged
// agent-specific grant to inherit, and a prompt asking for 'default' just means
// "this session's own default agent".
//
// This predicate does NOT refuse the switch. It used to gate a 409; it now gates
// only the 403 authz check in `agentSwitchRefusal`.
//
// The sentinel 'default' is non-binding on EITHER side: a session stored as
// 'default' has no privileged agent-specific grant to inherit, and a prompt
// asking for 'default' just means "this session's own default agent".
//
// Without that carve-out, the client's perfectly ordinary behaviour read as a
// switch: it resolves "the default" to a concrete name (e.g. `kortix`) for
// display and echoes it back on follow-up turns — and a first-turn race can send
// that name before the session's bound agent has even loaded.
function isConcreteAgentSwitch(requestedAgent: string | null, sessionAgent: string): boolean {
  if (!requestedAgent) return false;
  // Asking for the sentinel is asking for "this session's own agent" — never a
  // switch, and there is no concrete agent to authorize.
  if (requestedAgent === DEFAULT_AGENT_SENTINEL) return false;
  // NOTE: there is deliberately NO `sessionAgent === DEFAULT_AGENT_SENTINEL`
  // carve-out here. There used to be, and it was an authorization bypass
  // (CWE-863): the body's `agent` is only stripped when the REQUESTED agent is
  // the sentinel (see the `bodyWithoutPromptAgent` call site), so a
  // `default`-bound session naming a CONCRETE agent really did run that agent
  // and really did have the token re-minted to its connector/Kortix-CLI grant —
  // while skipping the `project.agent.read` check entirely. Anyone who could
  // use a default-bound session could therefore run any agent in the project.
  //
  // The carve-out was written for the old 409 refusal, where it was right: the
  // client resolves "the default" to a concrete name for display and echoes it
  // back, and refusing that ordinary echo 409'd every new session. It is wrong
  // for an authorization check. Authorizing the echo is correct and cheap — the
  // caller genuinely is asking to run that agent, and a member entitled to it
  // passes exactly as they do on the concrete-to-concrete path.
  return requestedAgent !== sessionAgent;
}

// The REAL collaborators for the pre-prompt turn-start block. Built HERE, not in
// ../pre-prompt-env-sync.ts: this file is re-evaluated by every proxy suite
// under its own `mock.module` stubs, so binding the four modules here is what
// keeps those stubs effective. Binding them in the extracted module instead
// would cache the real ones for the whole process the first time any test
// touched it.
const REAL_PRE_PROMPT_DEPS: PrePromptEnvSyncDeps = {
  syncEnv: syncSessionRuntimesEnvForPrompt,
  remintGrant: remintGrantForAgentSwitch,
  scheduleSnapshot: scheduleOpencodeSnapshotSync,
  generateTitle: generateSessionTitleFromFirstPrompt,
};

// === Core HTTP forwarder ======================================================
//
// Forwards one request to a sandbox port with the full upstream auth header set,
// auto-wake retries, redirect rewriting, and CORS injection. Exported so both
// proxy edges use it: the path-based Hono route below and the preview-origin handler
// (src/sandbox-proxy/preview-origin.ts).

export type PreviewProxyAccess =
  | {
      kind: 'principal';
      userId: string;
      /** The caller's own session when the credential is bound to one (a sandbox
       *  token). Kortix-as-a-Backend shares ONE userId across every end-user, so
       *  this is what separates them. Null means a non-session-bound principal.
       *  REQUIRED so a new entry point cannot silently omit it and fail open. */
      callerSessionId: string | null;
      /** The caller's AGENT/SANDBOX token binding — `callerKortixSessionId(c)`,
       *  never the raw `c.get('sessionId')`. Only the trigger-session manager
       *  override reads it (see connectors/share.ts). REQUIRED for the same
       *  reason as the two fields around it. */
      boundCredentialSessionId: string | null;
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
/**
 * Should the data-path proxy WAKE a stopped box instead of 503ing it?
 *
 * Two cases, and the difference between them is the whole point:
 *
 *  - A real user mutating OpenCode session data. A POST/PUT/PATCH/DELETE is an
 *    explicit action. A GET/HEAD/OPTIONS can be transcript hydration, cache
 *    warming, polling, or a background reconnect and must never resume a box.
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
  opts: {
    sandboxAuthored?: boolean;
    browserNavigation?: boolean;
    method?: string;
  } = {},
): boolean {
  if (status !== 'stopped' || accessKind !== 'principal') return false;
  if (opts.sandboxAuthored) return false;
  if (carriesSessionData(upstreamPort)) {
    const method = opts.method?.toUpperCase();
    return Boolean(method && !['GET', 'HEAD', 'OPTIONS'].includes(method));
  }
  return opts.browserNavigation === true && !carriesSessionData(upstreamPort);
}

/**
 * Should a WebSocket UPGRADE wake a stopped box?
 *
 * The HTTP data path wakes a parked box on explicit user intent
 * (`shouldAutoResumeStoppedSandbox`). The WebSocket path had no such branch at
 * all: it answered `503 sandbox not ready` and stopped there. A browser never
 * sees that status — a refused upgrade surfaces only as close code `1006` — so
 * the terminal reconnected against a parked box forever, and nothing in the
 * loop could ever wake it. Reloading the page did not help either: the panel's
 * `GET /kortix/pty` is a GET on a session-data port, which by policy also never
 * resumes. The terminal was therefore unrecoverable until the user prompted the
 * agent (a POST) or restarted the session.
 *
 * A terminal ATTACH is the same class of intent as a session mutation: a human
 * opened the panel or pressed "Reconnect now". The client marks exactly those
 * two connects with `wake=1` and NEVER marks its automatic backoff retries, so
 * the "passive resurrection" the resume policy exists to prevent (polling,
 * hydration, background reconnects) still cannot wake a box.
 *
 * Pure + exported so the gate is unit-tested without provisioning a box.
 */
export function shouldWakeStoppedSandboxForWsAttach(
  status: string,
  remainingPath: string,
  opts: { wakeRequested: boolean; accessKind?: string },
): boolean {
  if (status !== 'stopped') return false;
  if (!opts.wakeRequested) return false;
  if (opts.accessKind && opts.accessKind !== 'principal') return false;
  return classifyPtyWebSocketPath(remainingPath) !== null;
}
/**
 * Is this a proxied attempt at the daemon's DESTRUCTIVE branch reset?
 *
 * `/kortix/refresh?base=1` runs `git checkout -B <branch> <sha>` in the box, and
 * the branch IS the session id — so it discards every commit the session made
 * and deletes the files they added. Its one legitimate caller is the
 * warm-session workspace refresh at session create, which calls the daemon
 * directly and never comes through here.
 *
 * The PATH stays open on purpose: a plain `/kortix/refresh` is the SDK's
 * `restart` mode and users legitimately reach it. Only the flag is refused.
 *
 * Pure + exported so the gate is unit-tested without provisioning a box — the
 * same reason `shouldAutoResumeStoppedSandbox` is.
 */
export function isProxiedBaseReset(
  upstreamPort: number,
  remainingPath: string,
  queryString: string,
): boolean {
  if (!carriesSessionData(upstreamPort)) return false;
  // Strip the in-box `/proxy/{port}` prefix, as the connector gate does — a
  // request that reaches the daemon that way is the same request.
  const path = remainingPath.replace(/^\/proxy\/\d+(?=\/)/, '');
  if (!/^\/kortix\/refresh(?:$|[/?#])/.test(path)) return false;
  return new URLSearchParams(queryString).get('base') === '1';
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
  // Origin mode: this sandbox port is served on its OWN hostname, so the app is
  // alone on that origin. Two things become both safe and necessary there —
  // forwarding the app's cookies (see appCookieHeader) and leaving same-origin
  // responses free of injected CORS headers.
  opts: { originMode?: boolean } = {},
): Promise<Response> {
  let requestBody = body;

  // 1. One row fetch — enforces the v1 session-sandbox contract, ownership, and
  // active state, and yields the service key for upstream auth. (Previously two
  // separate queries for the same row.)
  const ptl = new ProvisionTimeline(sandboxId, 'proxy');
  let record = await loadSandbox(sandboxId);
  ptl.mark('load-sandbox');
  if (!record) {
    return jsonProxyError({ error: 'sandbox not found' }, 404, origin);
  }
  bindSandboxRequestContext(record, sandboxId);
  const userId = principalUserId(access);
  const callerSessionId = access.kind === 'principal' ? access.callerSessionId : null;
  const boundCredentialSessionId =
    access.kind === 'principal' ? access.boundCredentialSessionId : null;
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
  const ingressRequest = {
    port,
    path: remainingPath,
    transport: 'http' as const,
  };
  const upstreamPort = routeSandboxIngress(record, ingressRequest).effectivePort;
  // Did the BOX author this request? It holds two credentials that authenticate
  // perfectly well, and every deadline decision below — the turn-start
  // observation, the preview-use extend, the auto-resume — must exclude them or
  // the self-renewing lease this design deletes is rebuilt through the proxy.
  const sandboxAuthored = access.kind === 'principal' && access.sandboxAuthored;
  // "May the proxy send this body twice?" — its OWN predicate, no longer
  // borrowed from `shouldSyncProjectEnvBeforeProxy`. The two questions look
  // alike and are not: env sync is about `/message` + `/prompt_async` carrying
  // a user prompt, non-idempotency is about ANY call that creates a turn — and
  // `/command` does that while needing neither the agent-lock rewrite nor
  // title generation. Sharing one path list meant `/command` fell out of BOTH,
  // and losing the second one is what let a single `/webapp` submit execute
  // four times. See `isNonIdempotentSessionWrite`.
  const promptDelivery = isNonIdempotentSessionWrite(port, method, remainingPath);

  // The daemon port serves the session's OpenCode conversation + owner-synced
  // secrets; gate it on SESSION visibility (mirrors loadVisibleSession on the
  // REST side), not just account membership — closes the window where a member
  // whose access was revoked/downgraded replays captured ids on the data path.
  if (
    access.kind === 'principal' &&
    requiresSessionVisibility(upstreamPort) &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      callerSessionId: callerSessionId ?? null,
      boundCredentialSessionId,
    }))
  ) {
    throw new HTTPException(403, {
      message: 'Not authorized to access this session',
    });
  }
  // /kortix/env is a platform-only control endpoint that writes the sandbox's
  // live secret env. The API reaches it server-to-server (postEnvToDaemon),
  // never through this user-facing proxy — block it so an account member can't
  // inject arbitrary env into a sandbox by POSTing /v1/p/<id>/8000/kortix/env.
  if (carriesSessionData(upstreamPort) && /^\/kortix\/env(?:$|[/?#])/.test(remainingPath)) {
    return jsonProxyError({ error: 'not found' }, 404, origin);
  }
  // `/kortix/refresh?base=1` force-resets the session's branch onto the base tip
  // — `git checkout -B <branch> <sha>`, where the branch IS the session id — so
  // it discards every commit the session made and deletes the files they added.
  //
  // The path itself must stay open: the SDK's `restart` mode is a plain
  // `/kortix/refresh`, and users legitimately reach it. Only the destructive
  // flag is refused, and refused HERE because this is the layer that knows the
  // request came from a user at all. Its one legitimate caller is the
  // warm-session workspace refresh at session create, which calls the daemon
  // directly and never traverses this proxy.
  //
  // The daemon enforces this independently (it also demands the stripped
  // service-call header) — a destructive primitive should not depend on a remote
  // allowlist staying correct.
  if (isProxiedBaseReset(upstreamPort, remainingPath, queryString)) {
    console.warn(`[PREVIEW] Refused base=1 branch reset on ${sandboxId} from a proxied caller`);
    return jsonProxyError(
      {
        error: 'base reset is not available through the sandbox proxy',
        code: 'BASE_RESET_FORBIDDEN',
      },
      403,
      origin,
    );
  }
  // A turn whose required connectors cannot serve it is refused HERE — before the
  // sandbox is woken, before the dedupe claim, before the title is generated from
  // a prompt that will never run.
  //
  // The position is the whole design. Every one of those is downstream:
  //   - claimPromptDelivery (below) burns the Idempotency-Key. Refuse after it and
  //     the retry the user makes AFTER connecting Gmail comes back
  //     `200 {status:'duplicate'}` — their message silently discarded, which is a
  //     far worse bug than the one being fixed.
  //   - generateSessionTitleFromFirstPrompt would name the session after a turn
  //     that was refused.
  // The three existing early returns further down all sit after the claim and
  // have exactly that defect; this one deliberately does not join them.
  if (!sandboxAuthored && isConnectorGatedTurn(upstreamPort, method, remainingPath)) {
    const promptAgent = requestedPromptAgent(requestBody, incomingHeaders);
    // Authorization FIRST. The connector gate below reads this agent's manifest,
    // and its refusal names the connectors that agent requires — not something a
    // caller who may not run it should be able to enumerate by asking.
    const unauthorized = await agentSwitchRefusal(record, promptAgent, userId, sandboxId, origin);
    ptl.mark('agent-switch');
    if (unauthorized) return unauthorized;
    const refusal = await connectorGateRefusal(record, promptAgent, origin);
    if (refusal) return refusal;
  }
  if (record.status !== 'active') {
    // A stopped-but-resumable box wakes only on explicit user intent. Session
    // mutations and top-level preview navigation qualify. Transcript reads,
    // cache hydration, polling, and background reconnects return 503. The normal
    // session page calls `/start` before reading the runtime, so navigation still
    // resumes deterministically without making every authenticated GET wake-capable.
    if (
      shouldAutoResumeStoppedSandbox(record.status, upstreamPort, access.kind, {
        sandboxAuthored,
        browserNavigation: isBrowserNavigation(incomingHeaders),
        method,
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
        // We never dialled the box. This is our own row read, so it says
        // nothing about whether the runtime is reachable — a probe that counts
        // it as evidence of a dead box is counting our own answer.
        hop: 'control_plane',
        code: 'sandbox_not_ready',
        retry: true,
      });
    }
  }
  const serviceKey = record.serviceKey;

  // Dedupe OpenCode prompt delivery up-front. Claim a stable key before the retry
  // loop so a duplicate inbound prompt cannot enqueue the user message twice.
  //
  // The key is held in an OUTER binding so the give-up path below can release it
  // when delivery provably never happened. Without that release, a client retry
  // under the same Idempotency-Key hits the bogus 200 "duplicate" and the user's
  // prompt is silently lost.
  let promptDedupeKey: string | null = null;
  const idempotencyKey = incomingHeaders.get('idempotency-key');
  // Non-idempotent (never re-sent by us) and dedupe-claimed (a later lookalike
  // is short-circuited) are DIFFERENT guarantees — see
  // `shouldClaimPromptDelivery`. A command body has no client-unique field, so
  // claiming one on content alone silently swallows a deliberate re-run.
  if (promptDelivery && shouldClaimPromptDelivery(remainingPath, !!idempotencyKey?.trim())) {
    promptDedupeKey = promptDeliveryKey({
      idempotencyKey,
      sandboxId,
      sessionId: record.sessionId,
      body: requestBody,
    });
    if (!claimPromptDelivery(promptDedupeKey)) {
      return jsonProxyError({ status: 'duplicate', deduplicated: true }, 200, origin);
    }
    // Stamped HERE, and only here: past the dedupe claim, so a re-sent prompt
    // cannot double-count, and outside the retry loop below, so a wake retry
    // cannot either. This is the sidebar's authoritative "last activity" —
    // unlike the opencode_sessions snapshot scheduled further down, it needs no
    // sandbox round-trip, so a session stays correctly dated even when the box
    // is unreachable. See projects/session-activity.ts.
    void recordSessionActivity({
      sessionId: record.sessionId,
      projectId: record.projectId,
    });
  }

  // `deadline_at` is the idle-stop clock. This separate record is the durable
  // fact that a specific OpenCode turn is active. It is created immediately
  // before the first upstream delivery attempt, promoted only after a confirmed
  // or ambiguous acceptance, and removed by matching terminal evidence.
  const turnIdentity =
    !sandboxAuthored && isTurnStartRequest(upstreamPort, method, remainingPath)
      ? extractTurnIdentity(remainingPath, requestBody)
      : null;
  // The wire id OpenCode will actually see, once the placement check below has
  // run — the client's, or the proxy's re-mint. Echoed on the response so the
  // sender can correlate, and written into `turnIdentity` so the ledger and the
  // daemon's exact-message probe match the message that exists.
  let effectiveMessageId: string | null = null;
  const turnToken = turnIdentity ? crypto.randomUUID() : null;
  let turnLifecycleBegun = false;
  let turnLifecycleAccepted = false;
  const beginTurnLifecycle = async (): Promise<'granted' | 'unavailable'> => {
    if (!turnIdentity || !turnToken || turnLifecycleBegun) return 'granted';
    try {
      const outcome = await beginSandboxTurn(
        { externalId: sandboxId },
        { token: turnToken, ...turnIdentity },
      );
      turnLifecycleBegun = outcome === 'granted';
      return outcome === 'no_box' ? 'unavailable' : outcome;
    } catch (error) {
      console.error(
        `[turn-lifecycle] refused prompt for ${sandboxId}: delivery authority is unavailable`,
        error,
      );
      return 'unavailable';
    }
  };
  const acceptTurnLifecycle = async (): Promise<void> => {
    if (!turnLifecycleBegun || !turnToken || turnLifecycleAccepted) return;
    try {
      turnLifecycleAccepted = await acceptSandboxTurn({ externalId: sandboxId }, turnToken);
    } catch (error) {
      // OpenCode already accepted this non-idempotent request. Do not convert a
      // post-delivery database outage into a failed send or delete the durable
      // `delivering` record. The provider-neutral reaper probes that exact
      // token-bound record and promotes it when OpenCode reports the turn live.
      console.error(
        `[turn-lifecycle] acceptance persistence failed for ${sandboxId}; reaper will reconcile delivery`,
        error,
      );
    }
  };
  const abandonTurnLifecycle = async (): Promise<void> => {
    if (!turnLifecycleBegun || !turnToken || turnLifecycleAccepted) return;
    try {
      await abandonSandboxTurn({ externalId: sandboxId }, turnToken);
      turnLifecycleBegun = false;
    } catch (error) {
      // Cleanup failure must not replace the upstream response. The durable
      // delivery record expires through the reaper's exact-message probe.
      console.error(
        `[turn-lifecycle] delivery cleanup failed for ${sandboxId}; reaper will reconcile delivery`,
        error,
      );
    }
  };

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
  // A file upload is non-replayable for the same reason a prompt delivery is,
  // and the consequence is worse. The daemon NEVER overwrites: it writes with
  // O_CREAT|O_EXCL and, on collision, suffixes the name. So re-sending a body it
  // already wrote does not get absorbed — it lands a SECOND file. With this loop
  // retrying up to 4 times and the SDK retrying up to 3 on top, one user action
  // could deposit up to 12 copies and still report failure.
  const uploadDelivery = isUploadRequest({ method, path: remainingPath });
  // Requests whose body must never be sent twice.
  const nonReplayableWrite = promptDelivery || uploadDelivery;
  // False until this request reaches the non-idempotent upstream fetch.
  // Failures before it, such as env synchronization, are safe to retry.
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

  // Which hop the LAST attempt got as far as, for the give-up response below.
  // An attempt that never resolved an ingress address failed at the provider
  // edge; once it has one, everything after it is the box itself. Never dialling
  // at all (out of budget on the first pass) is the provider-edge case too — we
  // have no evidence about the box.
  let lastAttemptHop: ProxyHop = 'provider_ingress';

  // The one SSE endpoint proxied per sandbox. Its streams get a byte-counting
  // passthrough (below), and a previous stream that answered 200 without EVER
  // writing a byte — the stale-cached-ingress signature, which produces no
  // error status and therefore never invalidated anything — costs the next
  // connect its cache entry, so it re-resolves instead of re-dialling the
  // same dead address for the rest of the 5-minute TTL. See `sse-stall.ts`.
  const isSseEventStreamRequest = method === 'GET' && remainingPath.endsWith('/global/event');
  /** Set per attempt: did we hand the daemon the CLIENT's Accept-Encoding? */
  let upstreamEncodingForwarded = false;
  const sseStallKey = `${sandboxId}:${port}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const budgetRemainingMs = PROXY_RETRY_BUDGET_MS - (Date.now() - proxyStartedAt);
    if (budgetRemainingMs <= 500) break; // out of budget → friendly page below
    try {
      lastAttemptHop = 'provider_ingress';
      if (isSseEventStreamRequest && attempt === 0 && shouldBypassIngressCache(sseStallKey)) {
        console.warn(
          `[PREVIEW] previous /global/event stream for ${sandboxId}:${port} delivered 0 bytes — re-resolving ingress`,
        );
        invalidatePreviewLink(sandboxId, port);
      }
      const ingress = await resolveSandboxIngress(record, ingressRequest);
      ptl.mark('ingress');
      lastAttemptHop = portFailureHop(upstreamPort);
      const previewUrl = ingress.url;
      const targetUrl = previewUrl.replace(/\/$/, '') + remainingPath + queryString;

      if (shouldSyncProjectEnvBeforeProxy(port, method, remainingPath)) {
        const requestedAgent = requestedPromptAgent(requestBody, incomingHeaders);
        // The agent-lock 409 and the project.agent.read 403 used to live here.
        // They now run in `agentSwitchRefusal`, above the dedupe claim and above
        // the connector gate — see that function for why both moves matter.
        // Drop only the legacy 'default' sentinel so OpenCode resolves its own
        // `default_agent` (the real default the session booted with). A *concrete*
        // requested agent is forwarded untouched so the user can switch agents
        // within a session.
        if (requestedAgent === DEFAULT_AGENT_SENTINEL) {
          requestBody = bodyWithoutPromptAgent(requestBody, incomingHeaders);
        }
        const refusal = await runPrePromptEnvSync(
          {
            record,
            sandboxId,
            port,
            userId,
            origin,
            previewUrl,
            providerHeaders: ingress.headers,
            serviceKey,
            requestedAgent,
            body: requestBody,
            incomingHeaders,
          },
          REAL_PRE_PROMPT_DEPS,
        );
        if (refusal) {
          // The refusal was raised BELOW `claimPromptDelivery`, so returning it
          // as-is burns the caller's Idempotency-Key: their retry — the exact
          // thing a 503 tells them to make — would come back
          // `200 {"deduplicated":true}` and the message would be silently lost.
          //
          // Safe by construction: `runPrePromptEnvSync` talks to the DAEMON's
          // /kortix/env, never to opencode's session endpoints, and it runs
          // strictly before the upstream fetch — so nothing was delivered and a
          // re-delivery cannot double-enqueue. `promptDeliveryMayHaveReachedUpstream`
          // keeps that honest for the one path that could contradict it: a retry
          // attempt whose PREVIOUS attempt already fetched. Then the failure is
          // ambiguous and the claim must stay, exactly as in the giveup path.
          //
          // The defect is not new and is not command-specific — it is one of the
          // "three existing early returns [that] sit after the claim" named on
          // the connector gate above. Enabling this block for `/command` is what
          // made fixing it a precondition rather than a cleanup.
          if (promptDedupeKey && !promptDeliveryMayHaveReachedUpstream) {
            releasePromptDelivery(promptDedupeKey);
          }
          return refusal;
        }
      }

      // Build forwarding headers: copy the client's (minus stripped), force
      // identity encoding, regenerate trace headers, then apply the sandbox
      // auth/identity headers (service key, preview token, signed user-context)
      // last so they always win.
      ptl.mark('env-sync');
      const authHeaders = await buildSandboxUpstreamHeaders({
        sandboxId,
        userId,
        serviceKey,
        providerHeaders: ingress.headers,
      });

      // PLACE THE WIRE ID against the target session's actual tip — for ANY
      // target, child sessions included. See `prompt-wire-id-repair.ts` for the
      // incident this closes. One bounded newest-N read; fail-open (a failed
      // read keeps the client's id); runs after every refusal point and before
      // the ledger begins, so the identity recorded is the one delivered. Once
      // per request: a retry attempt keeps the placement the first computed.
      if (
        promptDelivery &&
        !sandboxAuthored &&
        effectiveMessageId === null &&
        isPromptWireIdRepairPath(remainingPath) &&
        // The inbox drain already placed it — one fewer round-trip.
        incomingHeaders.get(WIRE_ID_PLACED_HEADER) !== '1' &&
        // No client id, nothing to place — OpenCode mints, and the read is
        // skipped entirely so a plain body pays nothing.
        promptBodyMessageId(requestBody) !== null
      ) {
        const readUrl =
          previewUrl.replace(/\/$/, '') +
          promptTranscriptReadPath(remainingPath, PROMPT_TRANSCRIPT_READ_LIMIT);
        const newestKnownTime = await readNewestWireIdTime({ url: readUrl, headers: authHeaders });
        ptl.mark('wire-id-read');
        const placed = repairPromptWireId({
          body: requestBody,
          newestKnownTime,
          nowMs: Date.now(),
        });
        if (placed.outcome === 'reminted') {
          console.warn('[prompt-wire-id] re-minted a stale or malformed client wire id', {
            sandboxId,
            sessionId: record.sessionId,
            path: remainingPath,
            effectiveMessageId: placed.effectiveMessageId,
          });
          requestBody = placed.body;
        }
        effectiveMessageId = placed.effectiveMessageId ?? '';
        if (turnIdentity && placed.effectiveMessageId) {
          turnIdentity.messageId = placed.effectiveMessageId;
        }
      }

      const headers = new Headers();
      for (const [key, value] of incomingHeaders.entries()) {
        const name = key.toLowerCase();
        // On a preview origin the jar holds the app's own cookies plus ours.
        // Give the app back everything that is its own — a cookie-session app
        // is otherwise permanently logged out through the proxy.
        if (name === 'cookie' && opts.originMode) {
          const appCookies = appCookieHeader(value);
          if (appCookies) headers.set('cookie', appCookies);
          continue;
        }
        if (STRIP_FORWARD_HEADERS.has(name)) continue;
        headers.set(key, value);
      }
      upstreamEncodingForwarded = forwardsClientEncoding(port, remainingPath);
      if (upstreamEncodingForwarded) {
        // Pass the caller's own negotiation through, so the daemon can gzip and
        // the compressed bytes reach the client untouched (the API's compress
        // middleware passes a body that already carries `content-encoding`).
        const clientEncoding = incomingHeaders.get('accept-encoding');
        headers.set('Accept-Encoding', clientEncoding?.trim() || 'identity');
      } else {
        headers.set('Accept-Encoding', 'identity');
      }
      for (const [key, value] of Object.entries(getTraceHeaders())) {
        headers.set(key, value);
      }
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
        proxyAttemptTimeoutMs(budgetRemainingMs, {
          method,
          path: remainingPath,
        }),
      );
      let upstream: Response;
      try {
        // Begin after every pre-prompt refusal point, but before the first byte
        // can reach OpenCode. A fast session.idle can now delete this record;
        // the success path below promotes it with a token CAS and cannot revive
        // a turn that already ended.
        const turnLifecycleStart = await beginTurnLifecycle();
        ptl.mark('turn-begin');
        if (turnLifecycleStart !== 'granted') {
          if (promptDedupeKey) releasePromptDelivery(promptDedupeKey);
          return jsonProxyError(
            {
              error:
                'The sandbox lifecycle authority is temporarily unavailable. The prompt was not delivered.',
              code: 'sandbox_lifecycle_unavailable',
              retry: true,
            },
            503,
            origin,
          );
        }
        if (nonReplayableWrite) promptDeliveryMayHaveReachedUpstream = true;
        // Timed, so the response carries `Server-Timing: up;dur=…, api;dur=…`.
        // A HAR of a session open otherwise shows one opaque number for a
        // proxied read and no way to tell the sandbox hop from this API's own
        // work — which is exactly what blocked attributing the ~1.7 s on
        // `/p/<ext>/8000/agent`. Retries accumulate.
        upstream = await timeUpstream(() =>
          fetch(targetUrl, {
            method,
            headers,
            body: requestBody,
            redirect: 'manual',
            signal: attemptController.signal,
            // Bun extensions: no decompression (raw byte passthrough), duplex streaming —
            // not in the lib RequestInit type.
            decompress: false,
            duplex: 'half',
          } as RequestInit),
        );
      } finally {
        clearTimeout(connectTimer);
      }
      ptl.mark('upstream');

      if (upstream.status >= 300 && upstream.status < 400) {
        await abandonTurnLifecycle();
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
        await abandonTurnLifecycle();
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
          await abandonTurnLifecycle();
          const notReadyHeaders = clientResponseHeaders(upstream.headers, origin);
          return new Response(bodyText, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: notReadyHeaders,
          });
        }
      }

      if (upstream.status === 502 || upstream.status === 503) {
        // A prompt-delivery or upload POST is NEVER retried on a 5xx: an upstream
        // 502 can mean the sandbox already accepted the body (the gateway just
        // dropped the response), so re-POSTing would enqueue the message twice or
        // write the file twice. Pass the upstream response straight through to the
        // passthrough below. GET/idempotent requests retry as before.
        if (!nonReplayableWrite && attempt < MAX_RETRIES) {
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
        if (!nonReplayableWrite && isBrowserNavigation(incomingHeaders)) {
          void markSandboxUsed(sandboxId);
          return portUnreachableResponse({
            port,
            status: upstream.status,
            origin,
            incomingHeaders,
            reason: 'sandbox port unreachable',
            // The provider edge answered — it reached the box and found the
            // port shut. So the hop is whatever lives on that port: the runtime
            // (8000/4096/4097) or the user's own process.
            hop: portFailureHop(upstreamPort),
            upstreamStatus: upstream.status,
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
        await abandonTurnLifecycle();
        const errHeaders = clientResponseHeaders(upstream.headers, origin);
        return new Response(bodyText, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: errHeaders,
        });
      }

      // Got an HTTP response → sandbox is alive, pass it through with CORS.
      void markSandboxUsed(sandboxId);
      // A 2xx confirms acceptance. A 5xx on a non-replayable turn is ambiguous:
      // OpenCode may hold the message even though the response was lost. Both
      // cases must preserve the turn. A definitive 4xx abandons delivery.
      if (upstream.ok || (turnIdentity && upstream.status >= 500)) {
        await acceptTurnLifecycle();
      } else {
        await abandonTurnLifecycle();
      }
      if (promptDelivery) {
        ptl.mark('turn-accept');
        ptl.log({ path: remainingPath, status: upstream.status });
      }
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
      const respHeaders = clientResponseHeaders(upstream.headers, origin);
      if (effectiveMessageId) {
        respHeaders.set(EFFECTIVE_MESSAGE_ID_HEADER, effectiveMessageId);
        const exposed = respHeaders.get('Access-Control-Expose-Headers');
        respHeaders.set(
          'Access-Control-Expose-Headers',
          exposed ? `${exposed}, ${EFFECTIVE_MESSAGE_ID_HEADER}` : EFFECTIVE_MESSAGE_ID_HEADER,
        );
      }
      // The transcript list leaves the API WITHOUT its attachment bytes.
      //
      // The daemon strips these too (kortix-sandbox-agent-server/src/proxy.ts)
      // and that is the right home. This second pass exists for every sandbox
      // still running an older daemon image — a self-host does not rebuild
      // its templates on our schedule, and the read that motivated this
      // (20 messages = 7-19 MB, dying on a 30s browser deadline, retried
      // forever) was on exactly such a box. Idempotent by construction: a
      // reference is not a `data:` url, so a list the daemon already stripped
      // passes through with zero work.
      const listMatch =
        method === 'GET' && upstream.ok
          ? /^\/session\/([^/]+)\/message\/?$/.exec(remainingPath)
          : null;
      if (listMatch && (upstream.headers.get('content-type') ?? '').includes('application/json')) {
        const sessionID = decodeURIComponent(listMatch[1] ?? '');
        const text = await upstream.text();
        let body = text;
        try {
          const stripped = stripInlineAttachmentBytes(
            JSON.parse(text),
            (messageID, partID) =>
              `/kortix/part/${encodeURIComponent(sessionID)}/${encodeURIComponent(messageID)}/${encodeURIComponent(partID)}`,
          );
          if (stripped.stripped > 0) {
            body = JSON.stringify(stripped.value);
            console.info(
              `[PREVIEW] stripped ${stripped.stripped} inline attachment part(s), ${stripped.savedBytes} bytes, from ${sandboxId} ${remainingPath}`,
            );
          }
        } catch {
          // Not the JSON we expected — pass it through untouched. This path
          // must never be the reason a transcript read fails.
        }
        respHeaders.delete('content-length');
        respHeaders.delete('content-encoding');
        respHeaders.set('content-type', 'application/json; charset=utf-8');
        return new Response(body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: respHeaders,
        });
      }

      // SSE gets the byte-counting passthrough (chunks untouched, backpressure
      // preserved): a stream that ends having delivered ZERO bytes marks this
      // sandbox so the next connect re-resolves ingress — see `sse-stall.ts`.
      if (isSseEventStreamRequest && upstream.ok && upstream.body) {
        respHeaders.delete('content-length');
        return new Response(
          trackSseBytes(upstream.body, (bytes) => recordSseStreamEnd(sseStallKey, bytes)),
          {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: respHeaders,
          },
        );
      }

      // When we forwarded the client's `Accept-Encoding` (the
      // `/kortix/opencode/*` namespace), the daemon answered gzipped and the
      // ~1.4 s provider hop carried 0.9 KB instead of 8.7 KB — which is the
      // entire point. But `fetch` DECODES a `Content-Encoding` body per the
      // WHATWG spec while leaving the header and the compressed
      // `Content-Length` on the response object. Measured on Bun 1.3:
      // 55 compressed bytes on the wire, `content-encoding: gzip`,
      // `content-length: 55`, and 4,012 DECOMPRESSED bytes out of
      // `arrayBuffer()`. Forwarding those two headers with a decoded body is a
      // response no client can read, so both go. The API's own compress
      // middleware then re-compresses for the API->client hop; the two hops
      // negotiate independently, and the expensive one is the one that shrank.
      if (upstreamEncodingForwarded && respHeaders.has('content-encoding')) {
        respHeaders.set('x-kortix-upstream-encoding', respHeaders.get('content-encoding')!);
        respHeaders.delete('content-encoding');
        respHeaders.delete('content-length');
        const exposedEncoding = respHeaders.get('Access-Control-Expose-Headers');
        respHeaders.set(
          'Access-Control-Expose-Headers',
          exposedEncoding
            ? `${exposedEncoding}, x-kortix-upstream-encoding`
            : 'x-kortix-upstream-encoding',
        );
      }

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
        isLongTurnCompletionRequest({ method, path: remainingPath })
      ) {
        sawLongTurnTimeout = true;
        break;
      }

      // A prompt-delivery or upload POST must NOT be blindly retried on an
      // ambiguous failure: a timeout / abort / connection reset can mean the
      // sandbox already received and accepted the body, so re-POSTing would
      // enqueue the message twice or write the file twice. Only retry when the
      // error PROVES nothing reached the box (the upstream refused the
      // connection). Any other error stops here and returns the friendly
      // unreachable response below. (The Daytona "no IP / no runner" 400 branch —
      // a rejection before opencode — retries in the response path above, which
      // is safe.)
      if (
        promptDeliveryMayHaveReachedUpstream &&
        nonReplayableWrite &&
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
    await acceptTurnLifecycle();
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
  if (promptDeliveryMaybeAccepted) await acceptTurnLifecycle();
  else await abandonTurnLifecycle();
  return portUnreachableResponse({
    port,
    status: 502,
    origin,
    incomingHeaders,
    reason: 'sandbox upstream unreachable',
    // No upstream STATUS exists here — every attempt threw (refused, reset,
    // connect timeout), so there is nothing to report but which hop we got to.
    hop: lastAttemptHop,
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
  /** The caller's AGENT/SANDBOX token binding. Only the trigger-session manager
   *  override reads it (connectors/share.ts). REQUIRED, same reasoning. */
  boundCredentialSessionId: string | null;
  /** The client marked this attach as user-initiated (`wake=1`): the panel's
   *  first connect, or "Reconnect now". Automatic backoff retries never set it.
   *  See `shouldWakeStoppedSandboxForWsAttach`. */
  wakeRequested?: boolean;
}): Promise<
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; status: number; message: string }
> {
  const { sandboxId, userId, remainingPath, queryString } = opts;
  const callerSessionId = opts.callerSessionId;
  const boundCredentialSessionId = opts.boundCredentialSessionId;

  let record = await loadSandbox(sandboxId);
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
    requiresSessionVisibility(upstreamPort) &&
    !(await canAccessSandboxSession({
      sessionId: record.sessionId,
      projectId: record.projectId,
      accountId: record.accountId,
      userId,
      callerSessionId: callerSessionId ?? null,
      boundCredentialSessionId,
    }))
  ) {
    return {
      ok: false,
      status: 403,
      message: 'not authorized for this session',
    };
  }
  if (record.status !== 'active') {
    // A user-initiated terminal attach resumes a parked box, exactly like a
    // session mutation does on the HTTP path. Without this the socket can only
    // loop: the browser sees 1006, retries, and nothing ever wakes the sandbox.
    if (
      shouldWakeStoppedSandboxForWsAttach(record.status, remainingPath, {
        wakeRequested: opts.wakeRequested === true,
        accessKind: 'principal',
      })
    ) {
      const resumeExternalId = record.externalId;
      await resumeStoppedSandboxByExternalId(resumeExternalId).catch((err) => {
        console.warn(`[preview-ws] auto-resume failed for ${resumeExternalId}:`, err);
        return false;
      });
      // The resume flips the row to 'active' immediately; the box finishes
      // booting in the background and the client's next retry connects.
      const resumed = await loadSandbox(sandboxId);
      if (resumed) record = resumed;
    }
    if (record.status !== 'active') {
      return { ok: false, status: 503, message: `sandbox not ready (status: ${record.status})` };
    }
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

// The largest body the proxy will accept, matching Bun's own default socket
// ceiling (128 MiB). Declared here so the limit is a stated number the client is
// told about, rather than an implicit runtime default it discovers by failing.
export const MAX_PROXY_BODY_BYTES = 128 * 1024 * 1024;

// === Route handlers: ALL /:sandboxId/:port(/*) ===
//
// Thin wrappers around forwardToSandbox — extract params from the Hono context.

preview.all('/:sandboxId/:port/*', async (c) => {
  const sandboxId = c.req.param('sandboxId');
  const portStr = c.req.param('port');
  const port = Number.parseInt(portStr, 10);

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new HTTPException(400, { message: `Invalid port: ${portStr}` });
  }

  const userId = c.get('userId') as string;

  const method = c.req.method;

  // Refuse an over-large body BEFORE reading it, and say so in a response the
  // client can actually read.
  //
  // Neither Bun.serve call sets `maxRequestBodySize`, so the effective ceiling is
  // Bun's 128 MiB default, enforced at the SOCKET. That returns a bare 413 with
  // an EMPTY body and no CORS headers, so a cross-origin browser upload surfaces
  // as an opaque network/CORS failure rather than "your file is too big", and the
  // SDK can only render `Upload failed (413): Request Entity Too Large` — no
  // filename, no stated limit. Checking Content-Length here gets in front of the
  // socket and returns a real JSON body through `jsonProxyError`, which attaches
  // the CORS headers every other proxy response carries.
  //
  // Content-Length is client-supplied and absent on a chunked body, so this is
  // the friendly path, not the enforcement boundary. The socket limit remains the
  // hard stop.
  const contentLength = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BODY_BYTES) {
    return jsonProxyError(
      {
        error: `Request body is ${Math.round(contentLength / 1_048_576)} MB, over the ${Math.round(MAX_PROXY_BODY_BYTES / 1_048_576)} MB limit.`,
        message: `Request body is ${Math.round(contentLength / 1_048_576)} MB, over the ${Math.round(MAX_PROXY_BODY_BYTES / 1_048_576)} MB limit.`,
        code: 'UPLOAD_TOO_LARGE',
        max_bytes: MAX_PROXY_BODY_BYTES,
        received_bytes: contentLength,
      },
      413,
      c.req.header('Origin') || '',
    );
  }

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
      // The manager-override gate needs the AGENT binding, so it reads the
      // helper — same reason `sandboxAuthored` below does. The raw context var
      // is the SUPABASE login session id for a human on the network-fallback
      // branch, which would strip managers of the override.
      boundCredentialSessionId: callerKortixSessionId(c),
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
  // The app is mounted at /v1/p (see apps/api/src/index.ts), so a Location
  // built from the route-relative path drops the mount and sends the browser to
  // `https://<api>/<sandbox>/<port>/` — a 404. Mirrors the sibling normalizer in
  // routes/public-share.ts.
  return c.redirect(`/v1/p/${sandboxId}/${port}/${url.search}`, 301);
});

export { preview };
