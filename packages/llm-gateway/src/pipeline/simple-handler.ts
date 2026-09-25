import { upstreamFetch } from '../upstream-fetch';
import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayHooks,
  GatewayLogger,
  ModelRoutePlan,
  TokenCounts,
  UpstreamDescriptor,
  UsageEvent,
} from '../domain';
import { GatewayResolutionError, UpstreamHttpError } from '../errors';
import type { FetchImpl } from '../http';
import {
  type ExtractedUsage,
  type SseErrorFrame,
  estimateOutputTokens,
  estimatePromptTokens,
  extractUsageFromJson,
} from '../usage';
import { calculateCost } from '../usage/pricing';
import { UPSTREAM_HEADERS_TIMEOUT_MS, dispatch, rawProviderError } from './dispatch';
import { clampRetryAfterSeconds, gatewayErrorResponse } from './error-response';
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

  // `body` is the ONLY reference to the parsed request graph from here on.
  // It is nulled the moment dispatch has taken it (below), so a slow
  // time-to-first-byte upstream does not pin one extra copy of a multi-MB
  // multimodal request for the whole prefill.
  let body: Record<string, unknown> | null;
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
  let route: ModelRoutePlan | null;
  try {
    route =
      (await hooks.resolveRoute?.(principal, {
        requestedModel,
        requires: { imageInput: hasImage(body) },
      })) ?? null;
    routedModel = route?.primaryModel || requestedModel;
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

  let descriptor: UpstreamDescriptor | undefined;
  let resolvedCandidates: UpstreamDescriptor[] = [];
  try {
    resolvedCandidates = await hooks.resolveUpstream(principal, routedModel);
    descriptor = resolvedCandidates[0];
  } catch (error) {
    refundHold(hooks, principal, logger);
    const resolution = error instanceof GatewayResolutionError ? error : null;
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
  if (descriptor.billingMode !== 'none' && !principal.billingHold) {
    try {
      const billing = await hooks.assertBillingActive(principal.accountId);
      if (billing?.holdUsd) principal = { ...principal, billingHold: { amountUsd: billing.holdUsd } };
    } catch (error) {
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
  }

  const streaming = body.stream === true;
  if (streaming) body.stream_options = { include_usage: true };
  // Measured now, while the parsed body still exists: a billable stream that
  // ends before its usage frame is settled from this (see usage/estimate.ts).
  const promptTokenEstimate =
    streaming && descriptor.billingMode !== 'none' ? estimatePromptTokens(body) : 0;
  const primaryModel = routedModel;
  const pending = dispatch(
    body,
    {
      model: primaryModel,
      candidates: resolvedCandidates,
      fallbackModels: route?.fallbackModels,
      fallbackOn: route?.fallbackOn,
      // A fallback model gets its own clamped defaults, never the primary's.
      defaultsFor: (model) =>
        route?.generationDefaultsForModel?.(model) ??
        (model === primaryModel ? route?.generationDefaults : undefined),
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
    },
  );
  // Dispatch owns the parsed request now; this frame drops it before the
  // provider wait.
  body = null;
  const outcome = await pending;
  const served = outcome.descriptor;
  // The model that served, or failed last: a fallback model when the chain moved.
  routedModel = outcome.model;
  const { attempts, candidatesTried, attemptFailures } = outcome;
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
  const GATEWAY_STREAM_CODES = new Set(['client_aborted', 'upstream_inactivity_timeout']);
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
          cachedTokens: 0,
          cacheWriteTokens: 0,
        }
      : reported;
    if (estimated) {
      logger.warn(
        `[gateway] ${id}: stream ended without a usage frame (${streamError?.code ?? 'no error'}); settling an estimate of ${usage!.promptTokens} prompt + ${usage!.completionTokens} output tokens`,
      );
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
