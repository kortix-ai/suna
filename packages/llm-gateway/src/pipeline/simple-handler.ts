import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayHooks,
  GatewayLogger,
  TokenCounts,
  UpstreamDescriptor,
  UsageEvent,
} from '../domain';
import { GatewayResolutionError, UpstreamHttpError } from '../errors';
import { type FetchImpl, callUpstream } from '../http';
import { type ExtractedUsage, extractUsageFromJson } from '../usage';
import { calculateCost } from '../usage/pricing';
import { gatewayErrorResponse } from './error-response';
import { applyGenerationDefaults } from './generation-defaults';
import { DEFAULT_IMAGE_WINDOW, type ImageWindowOptions, applyImageWindow } from './image-window';
import { relayStream } from './streaming';
import { createTraceEmitter } from './trace';

export interface ChatCompletionRequest {
  authorization: string | undefined;
  rawBody: string;
  signal?: AbortSignal;
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

async function authorize(hooks: GatewayHooks, token: string): Promise<AuthorizeResult> {
  if (hooks.authorize) return hooks.authorize(token);
  let principal = await hooks.authenticate(token);
  if (!principal) {
    return { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' };
  }
  try {
    const billing = await hooks.assertBillingActive(principal.accountId);
    if (billing?.holdUsd) principal = { ...principal, billingHold: { amountUsd: billing.holdUsd } };
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

function refundHold(hooks: GatewayHooks, principal: AuthedPrincipal): void {
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
  void hooks.recordUsage(event).catch(() => {});
}

function rawProviderError(error: UpstreamHttpError): Response {
  return new Response(error.body || JSON.stringify({ error: { message: error.message } }), {
    status: error.status,
    headers: { 'content-type': 'application/json' },
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

  const admission = await authorize(hooks, token);
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
  const principal = admission.principal;

  // `body` is the ONLY reference to the parsed request graph from here on.
  // It is nulled the moment dispatch has taken it (below), so a slow
  // time-to-first-byte upstream does not pin one extra copy of a multi-MB
  // multimodal request for the whole prefill.
  let body: Record<string, unknown> | null;
  try {
    body = JSON.parse(req.rawBody) as Record<string, unknown>;
    req.rawBody = '';
  } catch {
    req.rawBody = '';
    refundHold(hooks, principal);
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
  try {
    const route =
      (await hooks.resolveRoute?.(principal, {
        requestedModel,
        requires: { imageInput: hasImage(body) },
      })) ?? null;
    routedModel = route?.primaryModel || requestedModel;
    body.model = routedModel;
    const defaults = route?.generationDefaultsForModel?.(routedModel) ?? route?.generationDefaults;
    body = applyGenerationDefaults(body, defaults);
  } catch (error) {
    refundHold(hooks, principal);
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
  try {
    descriptor = (await hooks.resolveUpstream(principal, routedModel))[0];
  } catch (error) {
    refundHold(hooks, principal);
    const resolution = error instanceof GatewayResolutionError ? error : null;
    return gatewayErrorResponse(400, {
      message: resolution?.message ?? `No provider is configured for model "${routedModel}"`,
      code: resolution?.code ?? 'model_unavailable',
      provider: '',
      requestedModel,
      resolvedModel: routedModel,
      requestId: id,
      suggestion: resolution?.suggestion ?? 'Connect the provider or choose another model.',
    });
  }
  if (!descriptor) {
    refundHold(hooks, principal);
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

  const streaming = body.stream === true;
  if (streaming) body.stream_options = { include_usage: true };
  let upstream: Response;
  try {
    const dispatch = callUpstream(body, descriptor, {
      fetchImpl,
      signal: req.signal,
      requestId: id,
    });
    // Dispatch has serialized (openai-compat) or translated (ai-sdk) the
    // body synchronously up to its first await; this frame no longer needs
    // the parsed graph. Drop it before waiting on the provider.
    body = null;
    upstream = await dispatch;
  } catch (error) {
    refundHold(hooks, principal);
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: descriptor.resolvedModel ?? routedModel,
      provider: descriptor.provider,
      billingMode: descriptor.billingMode,
      streaming,
      status: error instanceof UpstreamHttpError ? error.status : 502,
      ok: false,
      errorCode: 'upstream_error',
      errorMessage: error instanceof Error ? error.message : String(error),
      attempts: 1,
      candidatesTried: [descriptor.provider],
    });
    if (error instanceof UpstreamHttpError) return rawProviderError(error);
    return gatewayErrorResponse(502, {
      message: error instanceof Error ? error.message : 'Provider request failed',
      code: 'upstream_error',
      provider: descriptor.provider,
      requestedModel,
      resolvedModel: descriptor.resolvedModel ?? routedModel,
      requestId: id,
      suggestion: 'Retry the request or choose another model.',
    });
  }

  const settle = async (usage: ExtractedUsage | null): Promise<void> => {
    const counts: TokenCounts = usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        }
      : EMPTY_USAGE;
    const { upstreamCost, finalCost } = calculateCost(
      descriptor.resolvedModel ?? routedModel,
      counts,
      descriptor.billingMode === 'none' ? 0 : descriptor.markup,
      usage?.upstreamCostHint,
      descriptor.pricing,
    );
    if (counts.promptTokens + counts.completionTokens > 0 || principal.billingHold) {
      await hooks.recordUsage({
        ...counts,
        accountId: principal.accountId,
        actorUserId: principal.userId,
        projectId: principal.projectId,
        sessionId: principal.sessionId,
        provider: descriptor.provider,
        model: descriptor.resolvedModel ?? routedModel,
        upstreamCost,
        finalCost,
        billingMode: descriptor.billingMode,
        streaming,
        requestId: id,
        ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
      });
    }
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: descriptor.resolvedModel ?? routedModel,
      provider: descriptor.provider,
      billingMode: descriptor.billingMode,
      streaming,
      status: upstream.status,
      ok: upstream.ok,
      attempts: 1,
      candidatesTried: [descriptor.provider],
      usage: counts,
      upstreamCost,
      finalCost,
    });
  };

  if (streaming && upstream.body) {
    return new Response(
      relayStream({
        upstreamBody: upstream.body,
        requestId: id,
        logger,
        signal: req.signal,
        settle: async (usage) => settle(usage),
      }),
      { status: upstream.status, headers: passthroughHeaders(upstream.headers) },
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
  return new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: passthroughHeaders(upstream.headers),
  });
}
