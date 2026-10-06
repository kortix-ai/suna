import { HTTPException } from 'hono/http-exception';
import { ingressTargetUrl } from '../../platform/providers/ingress-url';
import {
  buildSandboxUpstreamHeaders,
  invalidatePreviewLink,
  markSandboxErrored,
  markSandboxUsed,
  resolveSandboxIngress,
  wakeSandbox,
} from '../backend';
import { jsonProxyError, isTurnStartEnvSync } from '../pre-prompt-env-sync';
import {
  clientResponseHeaders,
  isBrowserNavigation,
  isConnectionRefusedError,
  longTurnTimeoutResponse,
  portUnreachableResponse,
  sanitizeRedirectLocation,
} from '../preview-response';
import {
  PROXY_RETRY_BUDGET_MS,
  PROXY_RETRY_DELAYS_MS,
  isEnvRpcRequest,
  isFileImportRequest,
  isLongTurnCompletionRequest,
  isUploadRequest,
} from '../preview-retry-budget';
import { releasePromptDelivery } from '../prompt-dedupe';
import { isProviderIngressAuthFailure } from '../provider-auth';
import { portFailureHop } from '../proxy-hop';
import { shouldBypassIngressCache } from '../sse-stall';
import type { ForwardRequest, ForwardState } from './context';
import { placePromptWireId, syncEnvBeforeTurnStart } from './turn-start';
import {
  buildUpstreamRequestHeaders,
  respondFromUpstream,
  sendUpstreamAttempt,
} from './upstream';
import { isDaemonRuntimeNotReady } from './wake';

// The retry loop around the upstream hop: per-attempt budget, auto-wake of a
// stopped box, re-resolving a stale ingress link, and the give-up response.

const RETRY_DELAYS_MS = PROXY_RETRY_DELAYS_MS;
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** The request-scoped values the attempts share but never change. */
interface RetryPlan {
  nonReplayableWrite: boolean;
  sseStallKey: string;
}

// 2. Forward with auto-wake retry.
export async function forwardWithRetry(
  req: ForwardRequest,
  requestBody: ArrayBuffer | undefined,
): Promise<Response> {
  const { sandboxId, port, method, remainingPath, upstreamPort, promptDelivery } = req;
  const state: ForwardState = {
    requestBody,
    // The wire id OpenCode will actually see, once the placement check has
    // run — the client's, or the proxy's re-mint. Echoed on the response so the
    // sender can correlate, and written into `turnIdentity` so the ledger and the
    // daemon's exact-message probe match the message that exists.
    effectiveMessageId: null,
    wakeTriggered: false,
    // Only a CONFIRMED-dead provider signal (box stopped/archived) errors the row.
    // A transient unreachable / RX stall must NEVER error a sandbox whose daemon
    // health is green — that briefly flipped healthy boxes to 'error' (surfacing
    // the chat as failed + lagging the session list, 2026-06-14). For microVM
    // providers there is no such signal, so the preview proxy never errors the row;
    // liveness is owned by the health-check loop + reconciler, not a port request.
    sawDeadSignal: false,
    // False until this request reaches the non-idempotent upstream fetch.
    // Failures before it, such as env synchronization, are safe to retry.
    promptDeliveryMayHaveReachedUpstream: false,
    // A blocking session-turn (`POST /session/:id/message`) whose single attempt
    // (it gets ~the whole remaining budget, see proxyAttemptTimeoutMs) still hit
    // the connect-timer. That's a legitimately long-running, healthy turn, not a
    // stalled connection — see the giveup branch below for why it gets its own
    // response instead of the generic "sandbox unreachable" one.
    sawLongTurnTimeout: false,
    // A prompt delivery whose failure is AMBIGUOUS — a timeout/abort/reset where
    // opencode may already hold the message. When true we must NOT release the
    // dedupe claim on the unreachable path below (a retry could double-enqueue).
    // It stays false only when every attempt PROVED nothing was delivered
    // (connection refused), which is the one case a retry may safely re-deliver.
    promptDeliveryMaybeAccepted: false,
    // Which hop the LAST attempt got as far as, for the give-up response below.
    // An attempt that never resolved an ingress address failed at the provider
    // edge; once it has one, everything after it is the box itself. Never dialling
    // at all (out of budget on the first pass) is the provider-edge case too — we
    // have no evidence about the box.
    lastAttemptHop: 'provider_ingress',
    providerCredentialsRefreshed: false,
  };
  // A file upload is non-replayable for the same reason a prompt delivery is,
  // and the consequence is worse. The daemon NEVER overwrites: it writes with
  // O_CREAT|O_EXCL and, on collision, suffixes the name. So re-sending a body it
  // already wrote does not get absorbed — it lands a SECOND file. With this loop
  // retrying up to 4 times and the SDK retrying up to 3 on top, one user action
  // could deposit up to 12 copies and still report failure.
  // An attachment import is the same class: the daemon downloads the file and
  // does not observe a disconnect, so a replay downloads it a second time. Only
  // on the daemon port — `/file/import` elsewhere is the user's own route.
  const uploadDelivery =
    isUploadRequest({ method, path: remainingPath }) ||
    isFileImportRequest({ method, path: remainingPath, port: upstreamPort }) ||
    isEnvRpcRequest({ method, path: remainingPath, port: upstreamPort });
  // Requests whose body must never be sent twice.
  const nonReplayableWrite = promptDelivery || uploadDelivery;

  // Wall-clock budget so a cold/dead sandbox returns our friendly page BEFORE
  // the 60s ALB idle timeout severs the connection (→ Cloudflare's bare 502).
  const proxyStartedAt = Date.now();

  // `isSseEventStreamRequest` is computed earlier now (see the R2 comment
  // above `prefetchedIngress`) — its streams still get a byte-counting
  // passthrough (below), and a previous stream that answered 200 without EVER
  // writing a byte — the stale-cached-ingress signature, which produces no
  // error status and therefore never invalidated anything — still costs the
  // next connect its cache entry, so it re-resolves instead of re-dialling the
  // same dead address for the rest of the 5-minute TTL. See `sse-stall.ts`.
  const sseStallKey = `${sandboxId}:${port}`;
  const plan: RetryPlan = { nonReplayableWrite, sseStallKey };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const budgetRemainingMs = PROXY_RETRY_BUDGET_MS - (Date.now() - proxyStartedAt);
    if (budgetRemainingMs <= 500) break; // out of budget → friendly page below
    try {
      const outcome = await forwardAttempt(req, state, plan, attempt, budgetRemainingMs);
      if (outcome === 'retry') continue;
      return outcome;
    } catch (err) {
      // Re-throw our own HTTP exceptions (400, 403, etc.) — don't retry those.
      if (err instanceof HTTPException) throw err;
      if ((await recoverFromAttemptError(req, state, plan, attempt, err)) === 'stop') break;
    }
  }

  return giveUpForward(req, state);
}

/** One attempt: resolve ingress, prepare the turn, send, and classify the answer. */
async function forwardAttempt(
  req: ForwardRequest,
  state: ForwardState,
  plan: RetryPlan,
  attempt: number,
  budgetRemainingMs: number,
): Promise<Response | 'retry'> {
  const { sandboxId, port, method, remainingPath, queryString, upstreamPort, record, ingressRequest, ptl, userId, serviceKey } = req;
  state.lastAttemptHop = 'provider_ingress';
  if (req.isSseEventStreamRequest && attempt === 0 && shouldBypassIngressCache(plan.sseStallKey)) {
    console.warn(
      `[PREVIEW] previous /global/event stream for ${sandboxId}:${port} delivered 0 bytes — re-resolving ingress`,
    );
    invalidatePreviewLink(sandboxId, port);
  }
  // `prefetchedIngress` is null on this exact path — it is never started
  // for `isSseEventStreamRequest` (see the R2 comment above it), which is
  // what lets the invalidation just above always win against a stale
  // resolve instead of racing it.
  const ingress =
    attempt === 0 && req.prefetchedIngress
      ? await req.prefetchedIngress
      : await resolveSandboxIngress(record, ingressRequest);
  ptl.mark('ingress');
  state.lastAttemptHop = portFailureHop(upstreamPort);
  const previewUrl = ingress.url;
  const targetUrl = ingressTargetUrl(ingress, remainingPath + queryString);

  if (isTurnStartEnvSync(upstreamPort, method, remainingPath)) {
    const refusal = await syncEnvBeforeTurnStart(req, state, previewUrl, ingress.headers);
    if (refusal) return refusal;
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

  await placePromptWireId(req, state, previewUrl, authHeaders);

  const headers = buildUpstreamRequestHeaders(req, previewUrl, authHeaders);

  // Only log retries — the happy path is already covered by the
  // per-request "Request completed" INFO line, and logging every proxied
  // asset (e.g. each _next/static chunk) floods the console.
  if (attempt > 0) {
    console.log(
      `[PREVIEW] ${method} ${sandboxId}:${port}${remainingPath} -> ${targetUrl} (retry ${attempt})`,
    );
  }

  const sent = await sendUpstreamAttempt(
    req,
    state,
    targetUrl,
    headers,
    budgetRemainingMs,
    plan.nonReplayableWrite,
  );
  if ('refusal' in sent) return sent.refusal;
  const upstream = sent.upstream;

  const failure = await handleUpstreamFailureStatus(req, state, plan, upstream, previewUrl, attempt);
  if (failure) return failure;

  return respondFromUpstream(req, state, upstream, plan.sseStallKey);
}

/**
 * The upstream statuses this proxy acts on instead of passing through: a
 * provider auth failure, a redirect, a rejected signed context, the daemon's
 * not-ready 503, a port-not-ready 502/503, and Daytona's stopped-box 400.
 * Returns the response to send, `'retry'` for another attempt, or null to
 * pass the upstream response through.
 */
async function handleUpstreamFailureStatus(
  req: ForwardRequest,
  state: ForwardState,
  plan: RetryPlan,
  upstream: Response,
  previewUrl: string,
  attempt: number,
): Promise<Response | 'retry' | null> {
  const { sandboxId, port, method, remainingPath, origin, redirectPrefix, record, userId, serviceKey, promptDedupeKey, incomingHeaders, upstreamPort, ptl, turn } = req;
  const { nonReplayableWrite } = plan;
  // A resumed Daytona sandbox can reject a cached preview token. Its edge
  // answers either JSON 401 or a login redirect; neither is the daemon's
  // signed-context refusal. Drop every transport's cached link for this
  // port and refresh once for reads. Never replay a write here.
  if (await isProviderIngressAuthFailure(record.provider, upstream)) {
    await upstream.body?.cancel().catch(() => {});
    invalidatePreviewLink(sandboxId, port);
    if (!state.providerCredentialsRefreshed && (method === 'GET' || method === 'HEAD') && attempt < MAX_RETRIES) {
      state.providerCredentialsRefreshed = true;
      return 'retry';
    }
    await turn.abandon();
    // The provider rejected authentication before the daemon received it.
    if (promptDedupeKey) releasePromptDelivery(promptDedupeKey);
    return jsonProxyError({
      error: 'sandbox provider authentication unavailable',
      code: 'sandbox_provider_auth_unavailable',
      retry: true,
    }, 503, origin);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    await turn.abandon();
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
    await turn.abandon();
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
    if (isDaemonRuntimeNotReady(upstream.headers, bodyText)) {
      void markSandboxUsed(sandboxId);
      // The daemon rejected the request as not-ready, so the runtime did NOT
      // enqueue the prompt. Release the dedupe claim so the client's retry
      // (once the runtime is up) actually delivers instead of short-circuiting
      // to a bogus 200 "duplicate" that would drop the message.
      if (promptDedupeKey) releasePromptDelivery(promptDedupeKey);
      await turn.abandon();
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
      return 'retry';
    }
    // Retries exhausted and the port still isn't answering. Show the friendly
    // "port unreachable" page to browsers instead of the upstream's bare 5xx;
    // programmatic clients still get the real status + JSON via passthrough.
    if (!nonReplayableWrite && isBrowserNavigation(incomingHeaders)) {
      void markSandboxUsed(sandboxId);
      ptl.log({ path: remainingPath, port, upstream_status: upstream.status });
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
    // legacy allowlist: Daytona's edge marks a stopped or archived box only
    // with this 400 text, no code. Delete when Daytona types the answer.
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
      state.sawDeadSignal = true; // confirmed-dead → erroring the row is justified
      if (!state.wakeTriggered) {
        console.warn(
          `[PREVIEW] Sandbox ${sandboxId} is stopped/archived (Daytona: ${bodyText.slice(0, 120)}), triggering wake`,
        );
        await wakeSandbox(sandboxId);
        state.wakeTriggered = true;
      } else {
        console.warn(
          `[PREVIEW] Sandbox ${sandboxId} still booting (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
        );
      }
      invalidatePreviewLink(sandboxId, port);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      return 'retry';
    }
    // Not a Daytona stopped error — pass through.
    await turn.abandon();
    const errHeaders = clientResponseHeaders(upstream.headers, origin);
    return new Response(bodyText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: errHeaders,
    });
  }

  return null;
}

/**
 * An attempt threw (refused, reset, connect timeout). Returns `'stop'` to end
 * the loop now, or `'next'` after waking the box and backing off.
 */
async function recoverFromAttemptError(
  req: ForwardRequest,
  state: ForwardState,
  plan: RetryPlan,
  attempt: number,
  err: unknown,
): Promise<'stop' | 'next'> {
  const { sandboxId, port, method, remainingPath } = req;
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
    state.sawLongTurnTimeout = true;
    return 'stop';
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
    state.promptDeliveryMayHaveReachedUpstream &&
    plan.nonReplayableWrite &&
    !isConnectionRefusedError(err)
  ) {
    // Ambiguous: the box may already hold the message. Keep the dedupe
    // claim so a client retry can't double-enqueue.
    state.promptDeliveryMaybeAccepted = true;
    return 'stop';
  }

  if (!state.wakeTriggered) {
    await wakeSandbox(sandboxId);
    state.wakeTriggered = true;
  }
  if (attempt < MAX_RETRIES) {
    invalidatePreviewLink(sandboxId, port);
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
  return 'next';
}

/** Every attempt failed or the budget ran out: settle the claim and the turn, then answer. */
async function giveUpForward(req: ForwardRequest, state: ForwardState): Promise<Response> {
  const { sandboxId, port, remainingPath, origin, incomingHeaders, promptDedupeKey, ptl, turn } = req;
  if (state.sawLongTurnTimeout) {
    await turn.accept();
    return longTurnTimeoutResponse(origin);
  }

  // All retries exhausted. Only error the row when the provider CONFIRMED the
  // sandbox is dead — never on a transient unreachable / RX stall, which would
  // flip a health-green box to 'error' (the chat-failed + session-list-lag bug,
  // 2026-06-14). When not confirmed-dead, fail just this request gracefully; the
  // health-check loop owns liveness and will retry the box.
  if (state.sawDeadSignal) {
    await markSandboxErrored(sandboxId);
  }
  // The sandbox was never reachable. For a prompt delivery this path is only
  // taken after every attempt PROVED nothing was delivered (connection refused,
  // or out of budget before a second try) — an ambiguous 5xx/timeout/reset would
  // have returned above with the claim intact. So release the dedupe claim to let
  // the client's retry actually deliver, instead of losing the message to a
  // bogus 200 "duplicate".
  if (promptDedupeKey && !state.promptDeliveryMaybeAccepted) {
    releasePromptDelivery(promptDedupeKey);
  }
  if (state.promptDeliveryMaybeAccepted) await turn.accept();
  else await turn.abandon();
  // A give-up says the box was unreachable, not where the wall time went. The
  // stage deltas are the attribution; a prompt delivery already logs this
  // summary (KRTX-471).
  ptl.log({ path: remainingPath, port, hop: state.lastAttemptHop });
  return portUnreachableResponse({
    port,
    status: 502,
    origin,
    incomingHeaders,
    reason: 'sandbox upstream unreachable',
    // No upstream STATUS exists here — every attempt threw (refused, reset,
    // connect timeout), so there is nothing to report but which hop we got to.
    hop: state.lastAttemptHop,
  });
}
