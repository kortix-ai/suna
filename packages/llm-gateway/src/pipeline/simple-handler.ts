import { upstreamFetch } from '../upstream-fetch';
import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayAttemptFailure,
  GatewayHooks,
  GatewayLogger,
  ModelRoutePlan,
  TokenCounts,
  UpstreamDescriptor,
  UsageEvent,
} from '../domain';
import { GatewayResolutionError, type NoUpstreamReasonCode, UpstreamHttpError } from '../errors';
import { type FetchImpl, callUpstream } from '../http';
import {
  type ExtractedUsage,
  type SseErrorFrame,
  estimateOutputTokens,
  estimateCachedPromptTokens,
  estimatePromptTokens,
  extractUsageFromJson,
} from '../usage';
import { calculateCost } from '../usage/pricing';
import {
  UPSTREAM_HEADERS_TIMEOUT_MS,
  dispatch,
  fallbackCandidates,
  fallbackModelsOf,
  fallbackTakesOver,
  rawProviderError,
  upstreamHeadersTimeoutMs,
  withUpstreamHeadersTimeout,
} from './dispatch';
import { clampRetryAfterSeconds, gatewayErrorResponse, providerClientErrorBody } from './error-response';
import { DEFAULT_IMAGE_WINDOW, type ImageWindowOptions, applyImageWindow } from './image-window';
import {
  publicPayload,
  publicResponseHeaders,
  publicSseLines,
  publicUpstreamError,
  shownModel,
  shownProvider,
} from './public-identity';
import { relayStream, type StreamObservation } from './streaming';
import { createTraceEmitter } from './trace';

export interface ChatCompletionRequest {
  authorization: string | undefined;
  rawBody: string;
  signal?: AbortSignal;
  /**
   * An already-parsed body, used by the Anthropic ingress.
   *
   * That ingress parses the raw body, translates it, and used to
   * `JSON.stringify` the result only for this handler to `JSON.parse` it
   * straight back. On an image-heavy request that round trip is the
   * difference between charging 3x the wire size and holding 5.03x
   * (measured 2026-08-24: 16 MiB of images -> +80.5 MiB on /v1/messages
   * versus +32.1 MiB on /chat/completions), which is how a single admitted
   * request could exceed the whole task's memory.
   */
  parsedBody?: Record<string, unknown>;
}

export interface GatewayDeps {
  fetchImpl?: FetchImpl;
  logger?: GatewayLogger;
  /** Inline-image cap per request. See pipeline/image-window.ts. */
  imageWindow?: ImageWindowOptions;
}

export interface HandlerRuntime {
  hooks: GatewayHooks;
  logger: GatewayLogger;
  fetchImpl?: FetchImpl;
  imageWindow?: ImageWindowOptions;
}

function streamErrorTraceStatus(error: SseErrorFrame): number {
  if (error.code === 'client_aborted') return 499;
  if (
    typeof error.code === 'number' &&
    Number.isInteger(error.code) &&
    error.code >= 400 &&
    error.code <= 599
  ) {
    return error.code;
  }
  return 502;
}

/**
 * Resolution failures a project's own fallback chain takes over, as the HTTP
 * status the same failure has from a provider: every own key or ChatGPT account
 * paused after a rate limit is a 429, a login that needs reconnection is a 401,
 * and a model that is unavailable here — retired, not served by this
 * deployment, or no longer recognized — is a 404, the status a provider answers
 * for a model it will not serve. The chain's retry setting then decides exactly
 * as for a failed attempt. Every other resolution failure (not connected,
 * disabled, excluded by the agent's grant) is a setup or policy answer and
 * stays the request's error.
 */
const CHAIN_TAKES_OVER: Partial<Record<NoUpstreamReasonCode, number>> = {
  provider_pool_rate_limited: 429,
  provider_reauth_required: 401,
  model_not_found: 404,
  model_retired: 404,
  model_disabled_on_deployment: 404,
};

const EMPTY_USAGE: TokenCounts = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
};

function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S.*)$/i);
  return match ? match[1].trim() : null;
}

function requestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function hasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      const type = (part as { type?: unknown }).type;
      return type === 'image' || type === 'image_url' || type === 'input_image';
    });
  });
}

// `ADMISSION_UNAVAILABLE` is a TRANSPORT failure of the admission gate itself
// (the standalone gateway's `authorize` hook is an HTTP call to the API control
// plane), not a denial. It is deliberately distinct from every `ok: false`
// verdict the gate can return: those mean "the caller may not run this", this
// one means "we could not find out".
const ADMISSION_UNAVAILABLE = 'admission_unavailable';

async function authorize(hooks: GatewayHooks, token: string): Promise<AuthorizeResult> {
  if (hooks.authorize) return hooks.authorize(token);
  const principal = await hooks.authenticate(token);
  if (!principal) {
    return { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' };
  }
  try {
    await hooks.assertBudget?.(principal);
    return { ok: true, principal };
  } catch (error) {
    const reason = (error as { reason?: unknown })?.reason;
    return {
      ok: false,
      status: 402,
      errorCode: typeof reason === 'string' ? reason : 'subscription_required',
      message: error instanceof Error ? error.message : 'Billing inactive',
      principal,
    };
  }
}

function identity(principal: AuthedPrincipal) {
  return {
    accountId: principal.accountId,
    actorUserId: principal.userId,
    projectId: principal.projectId,
    sessionId: principal.sessionId,
    keyId: principal.keyId,
  };
}

function refundHold(
  hooks: GatewayHooks,
  principal: AuthedPrincipal,
  logger: GatewayLogger,
): void {
  if (!principal.billingHold) return;
  const event: UsageEvent = {
    ...EMPTY_USAGE,
    accountId: principal.accountId,
    actorUserId: principal.userId,
    projectId: principal.projectId,
    sessionId: principal.sessionId,
    provider: '',
    model: 'unknown',
    upstreamCost: 0,
    finalCost: 0,
    billingMode: 'none',
    streaming: false,
    requestId: requestId(),
    billingHoldUsd: principal.billingHold.amountUsd,
  };
  // A failed refund leaves the caller's admission hold un-returned — small, but
  // it is the customer's money and an empty `.catch(() => {})` is how the last
  // billing blind spot stayed invisible for a whole period. Log it.
  void hooks.recordUsage(event).catch((error: unknown) => {
    logger.error('[gateway] admission-hold refund failed', {
      accountId: principal.accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// Headers that describe the provider's WIRE framing, not its payload. `fetch`
// already decompressed the body and this gateway re-frames it (a relayed
// stream or a re-materialized string), so forwarding them lies to the next
// hop: the API reverse proxy's `fetch` saw `content-encoding: gzip` on a
// plaintext body and threw `ZlibError` on every non-streaming completion
// (local stack, 2026-08-24), and Caddy would hand the same pair straight to
// the client. Hop-by-hop headers (RFC 7230 §6.1) are dropped for the same
// reason.
const FRAMING_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
];

export function passthroughHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of FRAMING_HEADERS) headers.delete(name);
  return headers;
}

export async function handleChatCompletions(
  runtime: HandlerRuntime,
  req: ChatCompletionRequest,
): Promise<Response> {
  const { hooks, logger, fetchImpl } = runtime;
  const imageWindow = runtime.imageWindow ?? DEFAULT_IMAGE_WINDOW;
  const id = requestId();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const emit = createTraceEmitter(hooks, logger, id, startedAt, startedMs);

  const token = bearer(req.authorization);
  if (!token) {
    return gatewayErrorResponse(401, {
      message: 'Missing bearer token',
      code: 'missing_token',
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Provide a valid gateway key or account token.',
    });
  }

  // Every other hook this handler calls has its failure classified —
  // resolveRoute -> 502 `routing_unavailable`, resolveUpstream -> 400,
  // billing/budget -> 402. `authorize` did not, so a control-plane transport
  // failure (a timed-out or unreachable API) threw straight out of the whole
  // pipeline and was served by the host's catch-all as an opaque
  // `503 gateway_error "Gateway unavailable"` with empty model fields —
  // indistinguishable from a gateway crash, and the reason the GW-ACCESS-1
  // release-gate flake read as a product bug for two releases. Same 503 the
  // caller already got; now it says which hop failed, and it says so in the
  // gateway's own error envelope with a `retry-after`.
  let admission: AuthorizeResult;
  try {
    admission = await authorize(hooks, token);
  } catch (error) {
    // No principal exists yet, so there is nothing to refund and no account to
    // attribute a trace to — and `recordTrace` is another call to the control
    // plane this request just failed to reach. Log it and answer.
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`[gateway] ${id}: admission control unavailable — ${detail}`);
    return gatewayErrorResponse(503, {
      message: 'Gateway admission control is unavailable',
      code: ADMISSION_UNAVAILABLE,
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Retry the request.',
      retryAfterSeconds: 5,
    });
  }
  if (!admission.ok) {
    return gatewayErrorResponse(admission.status, {
      message: admission.message ?? 'Request denied',
      code: admission.errorCode,
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Check authentication, billing, and budget settings.',
    });
  }
  let principal = admission.principal;
  emit.mark('admitted');

  // One wallet admission per request: before dispatch when the routed model is
  // Kortix-billed, or before the first Kortix-billed fallback of a failed own
  // key or ChatGPT request. A hold it takes is settled or refunded as usual.
  let chargeAdmission: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null;
  const admitCharge = () => {
    chargeAdmission ??= (async () => {
      if (principal.billingHold) return { ok: true as const };
      try {
        const billing = await hooks.assertBillingActive(principal.accountId);
        if (billing?.holdUsd) principal = { ...principal, billingHold: { amountUsd: billing.holdUsd } };
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    return chargeAdmission;
  };
  const chargeAdmitted = async () => (await admitCharge()).ok;

  // `body` is the ONLY reference to the parsed request graph from here on.
  // It is nulled the moment dispatch has taken it (below), so a slow
  // time-to-first-byte upstream does not pin one extra copy of a multi-MB
  // multimodal request for the whole prefill.
  let body: Record<string, unknown> | null;
  // Rough (UTF-16 code units, not bytes — close enough for a size gate)
  // request size, captured before `rawBody` is cleared below. Used only to
  // decide whether a stream-cut transparent retry may afford ANOTHER
  // `structuredClone` of the body — see `streamRedispatchBody` below.
  const approxRequestSize = req.rawBody?.length ?? 0;
  try {
    body = req.parsedBody ?? (JSON.parse(req.rawBody) as Record<string, unknown>);
    req.parsedBody = undefined;
    req.rawBody = '';
  } catch {
    req.rawBody = '';
    refundHold(hooks, principal, logger);
    return gatewayErrorResponse(400, {
      message: 'Invalid JSON body',
      code: 'invalid_json',
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Send one valid JSON request body.',
    });
  }

  const window = applyImageWindow(body, imageWindow);
  if (window.dropped > 0) {
    logger.info(
      `[gateway] image window ${id}: kept ${window.total - window.dropped} of ${window.total} inline images`,
    );
  }

  const requestedModel = typeof body.model === 'string' ? body.model : '';
  let routedModel = requestedModel;
  // Reused below to decide whether a stream-cut transparent retry may afford
  // ANOTHER `structuredClone` of the body — see `streamRedispatchBody`.
  const requestHasImage = hasImage(body);
  let route: ModelRoutePlan | null;
  try {
    route =
      (await hooks.resolveRoute?.(principal, {
        requestedModel,
        requires: { imageInput: requestHasImage },
      })) ?? null;
    routedModel = route?.primaryModel || requestedModel;
    emit.mark('routed');
  } catch (error) {
    refundHold(hooks, principal, logger);
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: routedModel,
      status: 502,
      ok: false,
      errorCode: 'routing_unavailable',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return gatewayErrorResponse(502, {
      message: 'Model routing is unavailable',
      code: 'routing_unavailable',
      provider: '',
      requestedModel,
      resolvedModel: routedModel,
      requestId: id,
      suggestion: 'Retry the request.',
    });
  }

  // The model the route named. A rescued request starts at one of its fallbacks.
  const routeModel = routedModel;
  /**
   * Starts the project's own chain when the routed model has no usable
   * upstream: every own key or ChatGPT account is paused or needs reconnection
   * (see CHAIN_TAKES_OVER). The routed model is an own key or ChatGPT plan, so
   * a Kortix-billed fallback needs the wallet admission first.
   */
  const startChainWithout = async (resolution: GatewayResolutionError) => {
    const status = CHAIN_TAKES_OVER[resolution.code];
    if (!status || !route?.policyId.startsWith('project:')) return null;
    if (!fallbackTakesOver(route.fallbackOn ?? 'transient', { status })) return null;
    const models = fallbackModelsOf({ model: routeModel, fallbackModels: route.fallbackModels });
    for (const [index, model] of models.entries()) {
      const candidates = await fallbackCandidates(model, {
        byok: true,
        chosenByProject: true,
        resolveCandidates: (next) => hooks.resolveUpstream(principal, next),
        admitCharge: chargeAdmitted,
        logger,
        requestId: id,
      });
      if (!candidates.length) continue;
      logger.warn(`[gateway] ${id}: ${routeModel} is unavailable (${resolution.code}); the project's chain starts at ${model}`);
      const failure: GatewayAttemptFailure = {
        attempt: 1,
        provider: routeModel.split('/')[0] || routeModel,
        routeModel,
        resolvedModel: routeModel,
        stage: 'resolve',
        status,
        code: resolution.code,
        message: resolution.message,
      };
      return { model, candidates, remaining: models.slice(index + 1), unavailable: { model: routeModel, failure } };
    }
    return null;
  };

  let descriptor: UpstreamDescriptor | undefined;
  let resolvedCandidates: UpstreamDescriptor[] = [];
  let chain = route?.fallbackModels;
  let unavailable: { model: string; failure: GatewayAttemptFailure } | undefined;
  try {
    resolvedCandidates = await hooks.resolveUpstream(principal, routedModel);
    descriptor = resolvedCandidates[0];
    emit.mark('resolved');
  } catch (error) {
    const resolution = error instanceof GatewayResolutionError ? error : null;
    const started = resolution ? await startChainWithout(resolution) : null;
    if (!started) {
      refundHold(hooks, principal, logger);
      return gatewayErrorResponse(resolution?.code === 'provider_pool_rate_limited' ? 429 : 400, {
        message: resolution?.message ?? `No provider is configured for model "${routedModel}"`,
        code: resolution?.code ?? 'model_unavailable',
        provider: '',
        requestedModel,
        resolvedModel: routedModel,
        requestId: id,
        suggestion: resolution?.suggestion ?? 'Connect the provider or choose another model.',
        retryAfterSeconds: resolution?.retryAfterSeconds,
      });
    }
    resolvedCandidates = started.candidates;
    descriptor = started.candidates[0];
    routedModel = started.model;
    chain = started.remaining;
    unavailable = started.unavailable;
    emit.mark('resolved');
  }
  if (!descriptor) {
    refundHold(hooks, principal, logger);
    return gatewayErrorResponse(400, {
      message: `No provider is configured for model "${routedModel}"`,
      code: 'model_unavailable',
      provider: '',
      requestedModel,
      resolvedModel: routedModel,
      requestId: id,
      suggestion: 'Connect the provider or choose another model.',
    });
  }

  // Resolve the payee before touching the wallet. BYOK descriptors use the
  // customer's provider account and must never create a Kortix hold or debit.
  if (descriptor.billingMode !== 'none') {
    const admitted = await admitCharge();
    if (!admitted.ok) {
      const { error } = admitted;
      const reason = (error as { reason?: unknown })?.reason;
      return gatewayErrorResponse(402, {
        message: error instanceof Error ? error.message : 'Billing inactive',
        code: typeof reason === 'string' ? reason : 'subscription_required',
        provider: shownProvider(descriptor),
        requestedModel,
        resolvedModel: shownModel(descriptor, routedModel),
        requestId: id,
        suggestion: 'Check your subscription or add credits, then retry.',
      });
    }
    emit.mark('billed');
  }

  const streaming = body.stream === true;
  if (streaming) body.stream_options = { include_usage: true };
  // A BYOK request is billable too when the project's chain can move it to a
  // Kortix-billed model.
  const fallbackChosenByProject = route?.policyId.startsWith('project:') ?? false;
  const billable = descriptor.billingMode !== 'none' || (fallbackChosenByProject && Boolean(chain?.length));
  // Measured now, while the parsed body still exists: a billable stream that
  // ends before its usage frame is settled from this (see usage/estimate.ts).
  const promptTokenEstimate = streaming && billable ? estimatePromptTokens(body) : 0;
  const cachedTokenEstimate = estimateCachedPromptTokens(body, promptTokenEstimate);
  // Kept only so a STREAMING body that gets cut before a single byte reaches
  // the client can be transparently retried (see relayStream's `redispatch`
  // option / streaming.ts's `handleIncompleteTermination`). dispatch() owns
  // the parsed graph from here on (nulled below) and never retries once its
  // OWN attempt has produced output, so this covers the one case it
  // deliberately leaves alone: a cut AFTER a successful dispatch.
  //
  // A held clone for the whole streaming response lifetime is exactly the
  // "unbounded per-request memory" class this codebase has paid for
  // repeatedly (see memory-envelope.test.ts, 2026-08-22). Clone fresh only
  // for a body small enough that doing so is cheap; an inline-image-bearing
  // or otherwise large multimodal request gets no transparent retry — it
  // still gets the other two halves of this fix (never forward a partial
  // line, explicit terminal error frame) and falls straight to the error
  // frame on a cut instead of retrying first.
  const STREAM_REDISPATCH_MAX_BODY_SIZE = 256 * 1024;
  const streamRedispatchBody: Record<string, unknown> | null =
    streaming && !requestHasImage && approxRequestSize <= STREAM_REDISPATCH_MAX_BODY_SIZE
      ? structuredClone(body)
      : null;
  emit.mark('dispatch');
  const pending = dispatch(
    body,
    {
      model: routedModel,
      candidates: resolvedCandidates,
      fallbackModels: chain,
      fallbackOn: route?.fallbackOn,
      // `project:*` routes come from the project's own Routing settings.
      fallbackChosenByProject,
      // A fallback model gets its own clamped defaults, never the primary's.
      defaultsFor: (model) =>
        route?.generationDefaultsForModel?.(model) ??
        (model === routeModel ? route?.generationDefaults : undefined),
      unavailable,
    },
    {
      requestId: id,
      logger,
      signal: req.signal,
      // upstreamFetch, never bare globalThis.fetch: Bun's default 300 s idle
      // timeout would end a silent `max`-effort reasoning stretch with
      // `TimeoutError: The operation timed out.` (see upstream-fetch.ts).
      fetchImpl: fetchImpl ?? upstreamFetch,
      resolveCandidates: (model) => hooks.resolveUpstream(principal, model),
      notePoolRateLimit: hooks.notePoolRateLimit
        ? (secretId, seconds) => hooks.notePoolRateLimit!(principal, secretId, seconds)
        : undefined,
      refreshCredential: hooks.refreshCredential
        ? (descriptor) => hooks.refreshCredential!(principal, descriptor)
        : undefined,
      admitCharge: chargeAdmitted,
    },
  );
  // Dispatch owns the parsed request now; this frame drops it before the
  // provider wait.
  body = null;
  const outcome = await pending;
  emit.mark('upstream_response');
  // Mutable: a stream-cut transparent retry (below) can move this to the
  // candidate that actually answered the retry, exactly like dispatch()'s own
  // pool/profile/fallback moves already do.
  let served = outcome.descriptor;
  // The model that served, or failed last: a fallback model when the chain moved.
  routedModel = outcome.model;
  // Mutable: a stream-cut transparent retry (see `redispatchStream` below)
  // extends both when it re-dispatches, so the trace and billing records
  // reflect every attempt actually made, not just dispatch()'s own ladder.
  let attempts = outcome.attempts;
  let candidatesTried = outcome.candidatesTried;
  const { attemptFailures } = outcome;
  // Untried pool candidates of the SAME model, if any — "next pooled key"
  // gets first refusal on a stream-cut retry before re-dispatching the same
  // descriptor. Computed once `served` is known so it excludes whichever key
  // actually answered.
  const streamRedispatchCandidates: UpstreamDescriptor[] = served.poolSecretId
    ? resolvedCandidates.filter(
        (candidate) =>
          Boolean(candidate.poolSecretId) &&
          candidate.provider === served.provider &&
          candidate.poolSecretId !== served.poolSecretId,
      )
    : [];
  let streamRedispatchIndex = 0;
  const redispatchStream = async (): Promise<ReadableStream<Uint8Array> | null> => {
    if (!streamRedispatchBody) return null;
    const candidate = streamRedispatchCandidates[streamRedispatchIndex] ?? served;
    streamRedispatchIndex += 1;
    const timeoutMs = upstreamHeadersTimeoutMs(streamRedispatchBody, candidate, true);
    try {
      const response = await callUpstream(structuredClone(streamRedispatchBody), candidate, {
        fetchImpl: withUpstreamHeadersTimeout(fetchImpl ?? upstreamFetch, timeoutMs),
        signal: req.signal,
        requestId: id,
      });
      if (!response.body) return null;
      // Attribute whatever gets billed/logged from here on to the candidate
      // that actually answered, exactly like dispatch()'s own retries do.
      served = candidate;
      attempts += 1;
      candidatesTried = [...candidatesTried, `${candidate.provider}:stream-retry`];
      return response.body;
    } catch (error) {
      logger.warn(`[gateway] ${id}: stream-cut redispatch to ${candidate.provider} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
  if (!outcome.response) {
    const { error } = outcome;
    refundHold(hooks, principal, logger);
    const errorText =
      error instanceof UpstreamHttpError
        ? `${error.message} ${error.body}`
        : error instanceof Error ? error.message : String(error);
    const publicError = served.publicProvider
      ? publicUpstreamError(error instanceof UpstreamHttpError ? error.status : 0, errorText, routedModel)
      : null;
    if (publicError) {
      logger.warn(
        `[gateway] ${id}: ${served.provider} failed for ${served.resolvedModel ?? routedModel}: ${errorText.slice(0, 300)}`,
      );
    }
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: shownModel(served, routedModel),
      provider: shownProvider(served),
      ...(served.publicProvider
        ? { upstream: { provider: served.provider, model: served.resolvedModel ?? routedModel } }
        : {}),
      billingMode: served.billingMode,
      streaming,
      status: publicError?.status ?? (error instanceof UpstreamHttpError ? error.status : 502),
      ok: false,
      errorCode: publicError?.code ?? 'upstream_error',
      errorMessage: publicError?.message ?? (error instanceof Error ? error.message : String(error)),
      attempts,
      candidatesTried,
      attemptFailures,
    });
    if (publicError) {
      return gatewayErrorResponse(publicError.status, {
        message: publicError.message,
        code: publicError.code,
        provider: shownProvider(served),
        requestedModel,
        resolvedModel: routedModel,
        requestId: id,
        suggestion: publicError.suggestion,
        retryAfterSeconds:
          error instanceof UpstreamHttpError ? clampRetryAfterSeconds(error.headers?.['retry-after']) : undefined,
      });
    }
    if (error instanceof UpstreamHttpError) return rawProviderError(error);
    // A headers timeout is "try again", not "this request is malformed".
    const timedOut = (error as { name?: unknown })?.name === 'TimeoutError' && !req.signal?.aborted;
    if (timedOut)
      return gatewayErrorResponse(503, {
        message: `Provider ${served.provider} sent no response headers within ${UPSTREAM_HEADERS_TIMEOUT_MS}ms`,
        code: 'upstream_timeout',
        provider: served.provider,
        requestedModel,
        resolvedModel: served.resolvedModel ?? routedModel,
        requestId: id,
        suggestion: 'Retry the request, or choose another model.',
      });
    return gatewayErrorResponse(502, {
      message: error instanceof Error ? error.message : 'Provider request failed',
      code: 'upstream_error',
      provider: served.provider,
      requestedModel,
      resolvedModel: served.resolvedModel ?? routedModel,
      requestId: id,
      suggestion: 'Retry the request or choose another model.',
    });
  }
  const upstream = outcome.response;

  // Gateway-authored stream endings; their text names no upstream.
  const GATEWAY_STREAM_CODES = new Set([
    'client_aborted',
    'upstream_inactivity_timeout',
    // Gateway-authored: the message names no provider ("upstream stream ended
    // without a finish_reason or [DONE]" / "upstream stream error"), so it
    // never needs `publicUpstreamError`'s status/message classification.
    'upstream_incomplete_stream',
  ]);
  const publicStreamError = (streamError: SseErrorFrame): SseErrorFrame => {
    if (GATEWAY_STREAM_CODES.has(String(streamError.code))) return streamError;
    const code = Number(streamError.code);
    const classified = publicUpstreamError(Number.isFinite(code) ? code : 0, streamError.message ?? '', routedModel);
    return { message: classified.message, code: classified.code };
  };
  // Set when a managed-model upstream answered non-2xx: the trace records the
  // public error the client received.
  let publicFailure: { status: number; code: string; message: string } | null = null;
  const settle = async (
    reported: ExtractedUsage | null,
    streamError: SseErrorFrame | null = null,
    observed?: StreamObservation,
  ): Promise<void> => {
    // A stream that ended without the provider's usage frame still consumed
    // the prompt and every streamed token. Settle an estimate when the client
    // stopped it, or when output was already served; a provider failure
    // before any output served nothing and settles as zero.
    const estimated =
      !reported &&
      !!observed &&
      served.billingMode !== 'none' &&
      (observed.clientStopped || observed.outputChars > 0);
    const usage: ExtractedUsage | null = estimated
      ? {
          promptTokens: promptTokenEstimate,
          completionTokens: estimateOutputTokens(observed!.outputChars),
          cachedTokens: cachedTokenEstimate,
          cacheWriteTokens: 0,
        }
      : reported;
    if (estimated) {
      logger.warn(
        `[gateway] ${id}: stream ended without a usage frame (${streamError?.code ?? 'no error'}); settling an estimate of ${usage!.promptTokens} prompt + ${usage!.completionTokens} output tokens`,
      );
    }
    if (streamError?.code === 'upstream_incomplete_stream') {
      // The upstream ended without a finish_reason/[DONE]/error frame — see
      // relayStream's `handleIncompleteTermination`. Log it as its own,
      // greppable line (provider/model/endpoint/bytes/tokens/duration —
      // never prompt content) so a cluster of cuts on one endpoint is
      // visible, and count it toward the same pool cooldown a 429 uses — a
      // pooled key/endpoint that keeps truncating streams gets rotated away
      // from too, not just rate-limited ones. The cooldown is short: an
      // incomplete stream is not proof the key is dead, only unreliable now.
      const detail = streamError.detail as
        | { bytesForwarded?: number; durationMs?: number; redispatchAttempts?: number; reason?: unknown }
        | undefined;
      logger.warn(`[gateway] ${id}: incomplete upstream stream`, {
        requestId: id,
        provider: served.provider,
        model: served.resolvedModel ?? routedModel,
        endpoint: served.baseUrl,
        bytesForwarded: detail?.bytesForwarded ?? 0,
        outputChars: observed?.outputChars ?? 0,
        durationMs: detail?.durationMs,
        redispatchAttempts: detail?.redispatchAttempts ?? 0,
        underlyingReason: detail?.reason,
      });
      if (served.poolSecretId && hooks.notePoolRateLimit) {
        try {
          await hooks.notePoolRateLimit(principal, served.poolSecretId, 10);
        } catch (error) {
          logger.error('[gateway] could not record stream-cut cooldown', {
            secretId: served.poolSecretId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const counts: TokenCounts = usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        }
      : EMPTY_USAGE;
    const { upstreamCost, finalCost } = calculateCost(
      served.resolvedModel ?? routedModel,
      counts,
      served.billingMode === 'none' ? 0 : served.markup,
      usage?.upstreamCostHint,
      served.pricing,
    );
    if (counts.promptTokens + counts.completionTokens > 0 || principal.billingHold) {
      await hooks.recordUsage({
        ...counts,
        accountId: principal.accountId,
        actorUserId: principal.userId,
        projectId: principal.projectId,
        sessionId: principal.sessionId,
        provider: shownProvider(served),
        model: shownModel(served, routedModel),
        ...(served.publicProvider
          ? { upstream: { provider: served.provider, model: served.resolvedModel ?? routedModel } }
          : {}),
        upstreamCost,
        finalCost,
        billingMode: served.billingMode,
        streaming,
        requestId: id,
        ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
        ...(estimated ? { usageEstimated: true } : {}),
      });
    }
    const shownStreamError =
      streamError && served.publicProvider ? publicStreamError(streamError) : streamError;
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: shownModel(served, routedModel),
      provider: shownProvider(served),
      ...(served.publicProvider
        ? { upstream: { provider: served.provider, model: served.resolvedModel ?? routedModel } }
        : {}),
      billingMode: served.billingMode,
      streaming,
      status: publicFailure?.status ?? (streamError ? streamErrorTraceStatus(streamError) : upstream.status),
      ok: !streamError && upstream.ok,
      errorCode:
        publicFailure?.code ??
        (shownStreamError ? String(shownStreamError.code ?? 'upstream_stream_error') : undefined),
      errorMessage: publicFailure?.message ?? shownStreamError?.message,
      attempts,
      candidatesTried,
      attemptFailures,
      servedModel: routedModel,
      ...(routedModel !== routeModel ? { fallbackFrom: routeModel } : {}),
      usage: counts,
      upstreamCost,
      finalCost,
    });
  };

  if (served.publicProvider && !upstream.ok) {
    const upstreamText = await upstream.text().catch(() => '');
    logger.warn(
      `[gateway] ${id}: ${served.provider} ${upstream.status} for ${served.resolvedModel ?? routedModel}: ${upstreamText.slice(0, 300)}`,
    );
    const classified = publicUpstreamError(upstream.status, upstreamText, routedModel);
    publicFailure = classified;
    await settle(null);
    return gatewayErrorResponse(classified.status, {
      message: classified.message,
      code: classified.code,
      provider: shownProvider(served),
      requestedModel,
      resolvedModel: routedModel,
      requestId: id,
      suggestion: classified.suggestion,
      retryAfterSeconds: clampRetryAfterSeconds(upstream.headers.get('retry-after')),
    });
  }

  if (!upstream.ok && upstream.status < 500 && upstream.status !== 429) {
    const upstreamText = await upstream.text().catch(() => '');
    await settle(null);
    const headers = passthroughHeaders(upstream.headers);
    headers.set('content-type', 'application/json');
    return new Response(providerClientErrorBody(upstream.status, upstreamText), { status: upstream.status, headers });
  }

  if (streaming && upstream.body) {
    return new Response(
      relayStream({
        upstreamBody: upstream.body,
        requestId: id,
        upstreamProvider: served.provider,
        upstreamModel: served.resolvedModel ?? routedModel,
        logger,
        signal: req.signal,
        settle,
        // A non-2xx upstream "stream" is an arbitrary error body, not SSE —
        // never classify it as incomplete or retry it (see `treatAsSse`'s doc
        // comment in streaming.ts). This branch already excluded the
        // `served.publicProvider && !upstream.ok` case above, but a BYOK/
        // non-public-provider descriptor can still reach here non-2xx.
        treatAsSse: upstream.ok,
        redispatch: upstream.ok && streamRedispatchBody ? redispatchStream : undefined,
        ...(served.publicProvider
          ? { rewriteLines: (text: string) => publicSseLines(text, routedModel) }
          : {}),
      }),
      {
        status: upstream.status,
        headers: served.publicProvider
          ? publicResponseHeaders(upstream.headers)
          : passthroughHeaders(upstream.headers),
      },
    );
  }

  const responseText = await upstream.text();
  const data = (() => {
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      return null;
    }
  })();
  await settle(extractUsageFromJson(data));
  if (served.publicProvider) {
    const publicText =
      data && typeof data === 'object' && !Array.isArray(data)
        ? JSON.stringify(publicPayload(data as Record<string, unknown>, routedModel))
        : responseText;
    return new Response(publicText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: publicResponseHeaders(upstream.headers),
    });
  }
  return new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: passthroughHeaders(upstream.headers),
  });
}
