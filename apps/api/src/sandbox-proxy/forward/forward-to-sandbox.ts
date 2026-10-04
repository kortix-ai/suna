import { clientAbortTarget } from '../client-abort';
import { extractTurnIdentity, markTurnStopRequested } from '../../services/sessions/session-turn-ledger';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { agentLaunchableInProject } from '../../services/sessions/session-token-grant';
import { dropUndeclaredPromptAgent } from '../undeclared-prompt-agent';
import { isTurnStartRequest } from '../../services/sandboxes/sandbox-deadline';
import { loadSandbox, routeSandboxIngress, type SandboxRecord, type resolveSandboxIngress } from '../backend';
import {
  DEFAULT_AGENT_SENTINEL,
  isTurnStartEnvSync,
  jsonProxyError,
  requestedPromptAgent,
} from '../pre-prompt-env-sync';
import { isNonIdempotentSessionWrite } from '../prompt-dedupe';
import {
  agentSwitchRefusal,
  assertPreviewSandboxAccess,
  bindSandboxRequestContext,
  principalUserId,
  refuseSessionOrControlAccess,
  type PreviewProxyAccess,
} from './access';
import { forwardWithRetry } from './retry';
import { claimPromptDeliveryOnce, convergeTurnStartRuntime, createTurnLifecycle } from './turn-start';
import { wakeOrRefuseInactiveSandbox } from './wake';

// === Core HTTP forwarder ======================================================
//
// Forwards one request to a sandbox port with the full upstream auth header set,
// auto-wake retries, redirect rewriting, and CORS injection. Exported so both
// proxy edges use it: the path-based Hono route (routes/preview.ts) and the
// preview-origin handler (src/sandbox-proxy/preview-origin.ts).

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
  //
  // `record`: the sandbox row, when the caller read it moments ago: the
  // server-side prompt delivery (the active box it just picked as its target)
  // and the HTTP route (the row read while this request authenticated). The
  // turn-begin write below re-checks the box's status in the database, so a
  // row that went stale in between cannot deliver a turn.
  opts: { originMode?: boolean; record?: SandboxRecord } = {},
): Promise<Response> {
  let requestBody = body;

  // 1. One row fetch — enforces the v1 session-sandbox contract, ownership, and
  // active state, and yields the service key for upstream auth. (Previously two
  // separate queries for the same row.)
  const ptl = new ProvisionTimeline(sandboxId, 'proxy');
  let record = opts.record?.externalId === sandboxId ? opts.record : await loadSandbox(sandboxId);
  ptl.mark('load-sandbox');
  if (!record) {
    return jsonProxyError({ error: 'sandbox not found' }, 404, origin);
  }
  bindSandboxRequestContext(record, sandboxId);
  const userId = principalUserId(access);
  const callerSessionId = access.kind === 'principal' ? access.callerSessionId : null;
  const boundCredentialSessionId =
    access.kind === 'principal' ? access.boundCredentialSessionId : null;
  await assertPreviewSandboxAccess(access, sandboxId, userId, record);
  // Effective upstream port: Platinum opencode(4096) → the in-box agent on 8000.
  // The AUTH/CONTROL guards below (session-visibility gate + /kortix/env block)
  // key on THIS via carriesSessionData(), which covers BOTH 8000 and opencode's
  // 4096 — Platinum reroutes 4096→8000, Daytona does not, and gating on 8000
  // alone left the direct-:4096 Daytona path ungated.
  //
  // EVERY TURN-START PREPARATION KEYS ON `upstreamPort` + `remainingPath`, and
  // there is now ONE predicate for all of them (`isTurnStartEnvSync`, built on
  // `isTurnStartRequest`). The previous rule — "env-sync stays on the
  // client-addressed `port` ON PURPOSE, to behave identically to Daytona" — was
  // wrong, and it made one request get different preparations on different
  // providers: Platinum rewrote 4096→8000 so the sync ran, Daytona passed 4096
  // through so it did not, and a prompt at :4096 got the config convergence and
  // the undeclared-agent drop but no secret refresh and no grant re-mint.
  // `redirectPrefix`/`X-Forwarded-Prefix` DO still key on the client-addressed
  // `port`, and that one is genuinely on purpose: the prefix must reflect the
  // URL the client actually used (/4096).
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
  // borrowed from `isTurnStartEnvSync`. The two questions look
  // alike and are not: env sync is about `/message` + `/prompt_async` carrying
  // a user prompt, non-idempotency is about ANY call that creates a turn — and
  // `/command` does that while needing neither the agent-lock rewrite nor
  // title generation. Sharing one path list meant `/command` fell out of BOTH,
  // and losing the second one is what let a single `/webapp` submit execute
  // four times. See `isNonIdempotentSessionWrite`.
  const promptDelivery = isNonIdempotentSessionWrite(port, method, remainingPath);

  const accessRefusal = await refuseSessionOrControlAccess({
    access,
    record,
    sandboxId,
    userId,
    callerSessionId,
    boundCredentialSessionId,
    upstreamPort,
    remainingPath,
    queryString,
    origin,
  });
  if (accessRefusal) return accessRefusal;
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
  // INC-2026-09-15. Before ANY gate reads the body's agent — authorization, the
  // connector gate, the env sync, the token re-mint — an agent this session's
  // project does not declare is removed from the body. Every consumer below
  // then sees the session's own agent. Sandbox-authored turns included: they
  // skip the authorization gate, which is exactly why the name must be gone
  // before the re-mint reads it. See `undeclared-prompt-agent.ts`.
  // A client asking OpenCode to abort is a stop somebody REQUESTED. Record it on
  // the open turn before the abort is forwarded: the end frame that follows is
  // the same "Aborted" as an abort nobody asked for. A sandbox-authored call is
  // the agent acting, not a person, so it is left to read as what it is.
  const abortedOpencodeSessionId = sandboxAuthored
    ? null
    : clientAbortTarget(upstreamPort, method, remainingPath);
  if (abortedOpencodeSessionId) {
    await markTurnStopRequested(record.sessionId, 'UserStop', {
      opencodeSessionId: abortedOpencodeSessionId,
    });
  }

  if (isTurnStartEnvSync(upstreamPort, method, remainingPath)) {
    const guardProjectId = record.projectId;
    const checked = await dropUndeclaredPromptAgent({
      body: requestBody,
      headers: incomingHeaders,
      projectId: record.projectId,
      sessionId: record.sessionId,
      sandboxId,
      path: remainingPath,
      sessionAgent: record.agentName ?? DEFAULT_AGENT_SENTINEL,
      sandboxAuthored,
      userId: userId ?? null,
      userAgent: incomingHeaders.get('user-agent'),
      isLaunchable: (agentName) => agentLaunchableInProject(guardProjectId, agentName),
      log: (event) =>
        console.error('[PREVIEW] dropped an agent this project does not declare from a turn-start body', event),
    });
    requestBody = checked.body;
  }
  // Was `isConnectorGatedTurn`, a byte-identical second copy of the predicate
  // below. One definition: "a USER turn", i.e. `isTurnStartRequest` minus
  // `/summarize`.
  if (!sandboxAuthored && isTurnStartEnvSync(upstreamPort, method, remainingPath)) {
    const promptAgent = requestedPromptAgent(requestBody, incomingHeaders);
    // Authorization FIRST. The connector gate below reads this agent's manifest,
    // and its refusal names the connectors that agent requires — not something a
    // caller who may not run it should be able to enumerate by asking.
    const unauthorized = await agentSwitchRefusal(record, promptAgent, userId, sandboxId, origin);
    ptl.mark('agent-switch');
    if (unauthorized) return unauthorized;
    // The connector pre-flight that used to run here is gone. See
    // `SessionScopeInputSchema` in @kortix/api-contract: a turn is never refused
    // for an unconnected connector, because the refusal was unclearable from the
    // product. The connector call denies and hands back a connect link instead.
  }
  if (record.status !== 'active') {
    const woken = await wakeOrRefuseInactiveSandbox({
      record,
      sandboxId,
      port,
      upstreamPort,
      access,
      sandboxAuthored,
      method,
      incomingHeaders,
      origin,
    });
    if ('response' in woken) return woken.response;
    record = woken.record;
  }
  const serviceKey = record.serviceKey;

  // The one SSE endpoint proxied per sandbox. Computed here (not only where it
  // used to live, right before the retry loop) because the pre-flight
  // parallelization below (R2) needs it to decide whether the first-attempt
  // ingress resolve may be started early. See the comment on that stream's
  // stall recovery at the retry loop for why it is excluded.
  const isSseEventStreamRequest = method === 'GET' && remainingPath.endsWith('/global/event');
  // R2 (the turn-latency spec (PR #7840) §3): the first attempt's provider-ingress
  // resolve — this box's network address — has no data dependency on the
  // config/catalog convergence gates below, so it starts alongside them
  // instead of queuing behind both. Populated just below, inside the
  // turn-start branch; consumed by the retry loop's attempt 0.
  let prefetchedIngress: ReturnType<typeof resolveSandboxIngress> | null = null;

  // ── C9 — a prompt on a box that is behind converges FIRST, then runs ─────
  // THE one funnel: the HTTP proxy and the server-side prompt queue both
  // arrive here, and `isTurnStartRequest` covers the OpenCode ports (4096/
  // 4097) as well as 8000. The env-sync gate below is now the same predicate
  // minus `/summarize`, so the two can no longer disagree about one request.
  //
  // The position is load-bearing. This runs BEFORE `claimPromptDelivery` and
  // before the first upstream fetch, so an OpenCode swap here cannot lose a
  // claimed or delivered prompt, and it cannot burn an Idempotency-Key. It
  // never ends a running turn: the convergence refuses mid-turn.
  //
  // A box already on the project's current config costs nothing — see
  // `convergeBeforeTurnStart`, which answers from two memos with no network
  // call at all in that case.
  if (!sandboxAuthored && isTurnStartRequest(upstreamPort, method, remainingPath)) {
    const converged = await convergeTurnStartRuntime({
      record,
      ingressRequest,
      isSseEventStreamRequest,
      requestBody,
      incomingHeaders,
      ptl,
      origin,
    });
    prefetchedIngress = converged.prefetchedIngress;
    if (converged.refusal) return converged.refusal;
  }

  const claim = claimPromptDeliveryOnce({
    promptDelivery,
    incomingHeaders,
    sandboxId,
    record,
    requestBody,
    origin,
  });
  if ('response' in claim) return claim.response;
  const { promptDedupeKey } = claim;

  const turnIdentity =
    !sandboxAuthored && isTurnStartRequest(upstreamPort, method, remainingPath)
      ? extractTurnIdentity(remainingPath, requestBody)
      : null;

  return forwardWithRetry(
    {
      sandboxId,
      port,
      access,
      method,
      remainingPath,
      queryString,
      incomingHeaders,
      origin,
      redirectPrefix,
      publicOrigin,
      originMode: opts.originMode,
      ptl,
      record,
      userId,
      ingressRequest,
      upstreamPort,
      sandboxAuthored,
      promptDelivery,
      serviceKey,
      isSseEventStreamRequest,
      prefetchedIngress,
      promptDedupeKey,
      turnIdentity,
      turn: createTurnLifecycle(sandboxId, turnIdentity),
    },
    requestBody,
  );
}
