import { timeUpstream } from '../../../lib/upstream-timing';
import { recordTurnStageMarks } from '../../../lib/server-timing';
import { getTraceHeaders } from '../../../lib/request-context';
import {
  createExtendThrottle,
  extendSandboxDeadline,
  isPreviewUseObservation,
  previewGrantMs,
} from '../../sandboxes/sandbox-deadline';
import { markSandboxUsed } from '../backend';
import { stripInlineAttachmentBytes } from '../inline-attachments';
import { jsonProxyError } from '../pre-prompt-env-sync';
import { appCookieHeader } from '../preview-session';
import { STRIP_FORWARD_HEADERS, clientResponseHeaders } from '../preview-response';
import { EFFECTIVE_MESSAGE_ID_HEADER } from '../prompt-wire-id-repair';
import { proxyAttemptTimeoutMs } from '../preview-retry-budget';
import { releasePromptDelivery } from '../prompt-dedupe';
import { classifyRuntimeRequest } from '../runtime-request';
import { recordSseStreamEnd, trackSseBytes } from '../sse-stall';
import type { ForwardRequest, ForwardState } from './context';

// The upstream hop itself: the request headers sent to the box, the bounded
// fetch, and the response handed back to the client.

/**
 * Which upstream paths get the CLIENT's `Accept-Encoding` instead of `identity`.
 *
 * Identity is the right default and stays the default: this proxy REWRITES some
 * bodies on the way back (`stripInlineAttachmentBytes` does `await
 * upstream.text()` on a transcript list), and a rewriter handed gzip bytes
 * produces garbage. Forcing identity is what makes that safe without every
 * future rewrite having to remember to decompress.
 *
 * The daemon's Runtime API (`/kortix/runtime/*`, `/kortix/opencode/*` before W3) is the exception, and it earns it:
 *   • nothing on this proxy rewrites those bodies — the projection is already
 *     the trimmed shape, so there is nothing left to strip;
 *   • the whole point of the namespace is byte reduction across THIS hop.
 *     `/kortix/runtime/state` is 8.7 KB raw and 0.9 KB gzipped (WS-Z1 §5);
 *     forcing identity here would throw away 90% of the saving before the
 *     response ever reaches the API's own compressor.
 *
 * `/events` is excluded even inside that namespace: the daemon never gzips an
 * event stream, and asking it to would be asking for a buffered one.
 */
export function forwardsClientEncoding(port: number, remainingPath: string): boolean {
  if (port !== 8000) return false;
  // `/kortix/runtime` since W3; `/kortix/opencode` on a daemon built before it.
  if (!/^\/kortix\/(?:runtime|opencode)(?:$|\/)/.test(remainingPath)) return false;
  return !/^\/kortix\/(?:runtime|opencode)\/events(?:$|[/?#])/.test(remainingPath);
}

// One deadline write per minute per box for HUMAN preview traffic. Mirrors
// SANDBOX_TOUCH_INTERVAL_MS in ../backend.ts, for the same reason: a single page
// load is hundreds of requests and the extend is monotone, so collapsing them
// loses nothing.
const previewUseThrottle = createExtendThrottle(60_000);

/**
 * Build forwarding headers: copy the client's (minus stripped), force
 * identity encoding, regenerate trace headers, then apply the sandbox
 * auth/identity headers (service key, preview token, signed user-context)
 * last so they always win.
 */
export function buildUpstreamRequestHeaders(
  req: ForwardRequest,
  previewUrl: string,
  authHeaders: Record<string, string>,
): Headers {
  const { incomingHeaders, originMode, port, remainingPath, publicOrigin, redirectPrefix } = req;
  const headers = new Headers();
  for (const [key, value] of incomingHeaders.entries()) {
    const name = key.toLowerCase();
    // On a preview origin the jar holds the app's own cookies plus ours.
    // Give the app back everything that is its own — a cookie-session app
    // is otherwise permanently logged out through the proxy.
    if (name === 'cookie' && originMode) {
      const appCookies = appCookieHeader(value);
      if (appCookies) headers.set('cookie', appCookies);
      continue;
    }
    if (STRIP_FORWARD_HEADERS.has(name)) continue;
    headers.set(key, value);
  }
  if (forwardsClientEncoding(port, remainingPath)) {
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
  return headers;
}

/**
 * Begin the turn lifecycle, then one upstream fetch whose connect/header phase
 * is bounded. Returns the upstream response, or the refusal when the lifecycle
 * authority is unavailable (nothing was sent).
 */
export async function sendUpstreamAttempt(
  req: ForwardRequest,
  state: ForwardState,
  targetUrl: string,
  headers: Headers,
  budgetRemainingMs: number,
  nonReplayableWrite: boolean,
): Promise<{ upstream: Response } | { refusal: Response }> {
  const { method, remainingPath, upstreamPort, ptl, promptDedupeKey, origin, turn } = req;
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
      port: upstreamPort,
    }),
  );
  let upstream: Response;
  try {
    // Begin after every pre-prompt refusal point, but before the first byte
    // can reach OpenCode. A fast session.idle can now delete this record;
    // the success path below promotes it with a token CAS and cannot revive
    // a turn that already ended.
    const turnLifecycleStart = await turn.begin();
    ptl.mark('turn-begin');
    if (turnLifecycleStart !== 'granted') {
      if (promptDedupeKey) releasePromptDelivery(promptDedupeKey);
      return {
        refusal: jsonProxyError(
          {
            error:
              'The sandbox lifecycle authority is temporarily unavailable. The prompt was not delivered.',
            code: 'sandbox_lifecycle_unavailable',
            retry: true,
          },
          503,
          origin,
        ),
      };
    }
    if (nonReplayableWrite) state.promptDeliveryMayHaveReachedUpstream = true;
    // Timed, so the response carries `Server-Timing: up;dur=…, api;dur=…`.
    // A HAR of a session open otherwise shows one opaque number for a
    // proxied read and no way to tell the sandbox hop from this API's own
    // work — which is exactly what blocked attributing the ~1.7 s on
    // `/p/<ext>/8000/agent`. Retries accumulate.
    upstream = await timeUpstream(() =>
      fetch(targetUrl, {
        method,
        headers,
        body: state.requestBody,
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
  return { upstream };
}

/**
 * Got an HTTP response → sandbox is alive, pass it through with CORS. Settles
 * the turn lifecycle, records the preview-use observation, and rewrites the
 * three bodies this proxy owns (a nameable 500, a transcript list, the SSE
 * stream); every other body streams through untouched.
 */
export async function respondFromUpstream(
  req: ForwardRequest,
  state: ForwardState,
  upstream: Response,
  sseStallKey: string,
): Promise<Response> {
  const { sandboxId, method, remainingPath, origin, access, sandboxAuthored, upstreamPort, promptDelivery, ptl, record, turnIdentity, turn, isSseEventStreamRequest } = req;
  void markSandboxUsed(sandboxId);
  // A 2xx confirms acceptance. A 5xx on a non-replayable turn is ambiguous:
  // OpenCode may hold the message even though the response was lost. Both
  // cases must preserve the turn. A definitive 4xx abandons delivery.
  if (upstream.ok || (turnIdentity && upstream.status >= 500)) {
    await turn.accept();
  } else {
    await turn.abandon();
  }
  if (promptDelivery) {
    ptl.mark('turn-accept');
    const summary = ptl.log({ path: remainingPath, status: upstream.status });
    // The turn-latency spec (PR #7840) §5: put the same breakdown on the wire via
    // the existing Server-Timing mechanism (lib/server-timing.ts), not a
    // second header — see that module's doc for why.
    recordTurnStageMarks(summary.marks);
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
  if (state.effectiveMessageId) {
    respHeaders.set(EFFECTIVE_MESSAGE_ID_HEADER, state.effectiveMessageId);
    const exposed = respHeaders.get('Access-Control-Expose-Headers');
    respHeaders.set(
      'Access-Control-Expose-Headers',
      exposed ? `${exposed}, ${EFFECTIVE_MESSAGE_ID_HEADER}` : EFFECTIVE_MESSAGE_ID_HEADER,
    );
  }

  // ── Rule 5 — kill the opaque 500 (the runtime-convergence contract (PR #7785) §3) ──
  // A turn that cannot run because the box's model map lacks the requested
  // model answers `500 {"name":"UnknownError","ref":"err_…"}` today — a bug,
  // not a state. Named here rather than fixed on the daemon (a parallel
  // branch owns the turn-start model-catalog refresh): if this session's
  // box is exactly the one Rule 1's diff already flags as behind on its
  // catalog, replace the opaque body with one that names the cause and
  // carries both fingerprints. Conservative by construction — only fires
  // with POSITIVE evidence (the box reported a DIFFERENT fingerprint than
  // the platform's current one); anything else passes through unchanged.
  if (promptDelivery && !sandboxAuthored && upstream.status === 500) {
    const bodyText = await upstream.text();
    const named = await (async () => {
      try {
        const { nameStaleModelCatalogError } = await import(
          '../../runtime-convergence/name-stale-catalog-error'
        );
        return await nameStaleModelCatalogError(bodyText, {
          desiredRuntime: async () =>
            (await import('../../runtime-convergence/desired')).computeDesiredRuntime({ releaseId: null }),
          actualRuntime: async () => {
            const { readSandboxConfigState } = await import('../../sessions/session-reload');
            const { UNREPORTED_ACTUAL_RUNTIME } = await import('../../runtime-convergence/actual');
            const state = await readSandboxConfigState({ sessionId: record.sessionId }).catch(() => null);
            return state?.runtimeTruth ?? UNREPORTED_ACTUAL_RUNTIME;
          },
        });
      } catch {
        return null;
      }
    })();
    if (named) {
      respHeaders.set('content-type', 'application/json; charset=utf-8');
      respHeaders.delete('content-length');
      respHeaders.delete('content-encoding');
      return new Response(JSON.stringify(named), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    }
    // Not our cause to name — pass the bytes we already read through
    // unchanged (the stream itself is consumed, so this can't fall
    // through to the generic `upstream.body` passthrough below).
    return new Response(bodyText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }

  // The transcript list leaves the API WITHOUT its attachment bytes.
  //
  // The daemon strips these too (kortix-sandbox-agent-server/src/app/server.ts)
  // and that is the right home. This second pass exists for every sandbox
  // still running an older daemon image — a self-host does not rebuild
  // its templates on our schedule, and the read that motivated this
  // (20 messages = 7-19 MB, dying on a 30s browser deadline, retried
  // forever) was on exactly such a box. Idempotent by construction: a
  // reference is not a `data:` url, so a list the daemon already stripped
  // passes through with zero work.
  const listRequest = upstream.ok ? classifyRuntimeRequest(method, remainingPath) : null;
  if (
    listRequest?.kind === 'message-list' &&
    (upstream.headers.get('content-type') ?? '').includes('application/json')
  ) {
    const sessionID = listRequest.runtimeSessionId;
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

  // When we forwarded the client's `Accept-Encoding` (the `/kortix/runtime/*`
  // namespace), the daemon answered gzipped and the provider hop carried
  // 0.9 KB instead of 8.7 KB. The upstream fetch runs with
  // `decompress: false`, so `upstream.body` is those raw compressed bytes:
  // the daemon's `content-encoding` and `content-length` describe them and
  // go to the client untouched. The API's compress middleware skips a body
  // that is already encoded (preview-encoding-passthrough.test.ts).

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
