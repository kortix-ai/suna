import type { AuthedPrincipal, ModelRoutePlan, UpstreamDescriptor, UsageEvent } from '../domain';
import { GatewayResolutionError } from '../errors';
import {
  aiGatewaySseFromFullStream,
  guardAgainstUnhandledResultRejections,
  resolveAiModel,
  toTransportError,
} from '../transports/ai-sdk';
import {
  type DecodedLanguageModelRequest,
  LanguageModelRequestError,
  decodeLanguageModelRequest,
} from '../transports/ai-sdk/language-model-request';
import type { NativeBillingUsage } from '../transports/ai-sdk/sse-native';
import { calculateCost } from '../usage';
import { gatewayErrorResponse } from './error-response';
import { admit } from './handler';
import type { HandlerRuntime } from './handler';

// ---------------------------------------------------------------------------
// AI-SDK-NATIVE ingress handler (`POST /language-model`).
//
// PHASE 1 — additive, behind the `aiSdkNative` flag. This is a SEPARATE thin
// handler that REUSES the stateless pipeline machinery:
//   - `admit`               — the exact auth + billing + budget gate the chat
//                             path uses (exported from handler.ts).
//   - `hooks.resolveRoute`  — the host's routing policy (primary + fallbacks).
//   - `hooks.resolveUpstream` — the host's per-model candidate resolution.
//   - `resolveAiModel`      — the exact provider/model construction the chat
//                             path uses.
//   - `calculateCost` + `hooks.recordUsage` — the exact billing path.
//
// Only the request-DECODE (AI-gateway CallOptions instead of an OpenAI body)
// and the response-SERIALIZE (lossless `aiGatewaySseFromFullStream` instead of
// `openAiSseFromFullStream`) differ. The lossless serializer is the whole
// point: it preserves the Anthropic reasoning `signature`
// (`providerMetadata.anthropic`) the OpenAI re-encode drops.
//
// DEFERRED to Phase 2/3 (documented, NOT silently missing):
//   - Mid-stream candidate failover + empty-completion retries. The chat path's
//     `runFailover`/`probeStream`/`relayStream` operate on OpenAI-shaped SSE
//     BYTES; reusing them for AI-gateway frames needs a pluggable content/usage
//     scanner (a real but separate seam). This handler resolves candidates and
//     dispatches the FIRST viable one; model-level "no upstream configured"
//     fallback still works, but per-turn provider failover does not yet.
//   - Non-streaming (`ai-language-model-streaming: false`) collects the stream
//     into a single JSON result — exact `doGenerate` wire parity is Phase 2.
//   - `buildAiSdkArgs`'s thinking/caching re-shaping. opencode's
//     `@ai-sdk/gateway` already sends provider-native `providerOptions`, so the
//     decoded call args are forwarded to `streamText` verbatim here.
// ---------------------------------------------------------------------------

// Imported lazily via a typed shim so this module does not hard-depend on the
// `ai` package's streamText type surface beyond what it uses.
import { streamText } from 'ai';

export interface LanguageModelRequest {
  authorization: string | undefined;
  /** Case-insensitive header getter — the model id, spec version, and streaming
   *  flag are read from headers (see language-model-request.ts). */
  header: (name: string) => string | undefined;
  rawBody: string;
  signal?: AbortSignal;
}

function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A synthetic zero-usage event that refunds an admission hold — identical
// mechanism to the chat handler's `refundBillingHold` (a hold-only event always
// reconciles to a full refund on the host side).
function refundBillingHold(
  runtime: HandlerRuntime,
  target: AuthedPrincipal | undefined,
  requestId: string,
): void {
  const hold = target?.billingHold;
  if (!hold) return;
  const refundEvent: UsageEvent = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    accountId: target.accountId,
    actorUserId: target.userId,
    projectId: target.projectId,
    sessionId: target.sessionId,
    provider: '',
    model: 'unknown',
    upstreamCost: 0,
    finalCost: 0,
    billingMode: 'none',
    streaming: false,
    requestId,
    billingHoldUsd: hold.amountUsd,
  };
  void runtime.hooks
    .recordUsage(refundEvent)
    .catch((err) => runtime.logger.warn(`[llm-gateway] native billing-hold refund failed:`, err));
}

interface Candidate {
  descriptor: UpstreamDescriptor;
  routeModel: string;
}

// Resolve the finite candidate set for this request, reusing the host's route
// policy + per-model resolver exactly like the chat handler.
async function resolveCandidates(
  runtime: HandlerRuntime,
  principal: AuthedPrincipal,
  decoded: DecodedLanguageModelRequest,
): Promise<{ candidates: Candidate[]; routedModel: string; resolutionError: GatewayResolutionError | null }> {
  const requestedModel = decoded.headers.modelId;
  let route: ModelRoutePlan | null = null;
  try {
    route =
      (await runtime.hooks.resolveRoute?.(principal, {
        requestedModel,
        requires: { imageInput: decoded.hasImageInput },
      })) ?? null;
  } catch (err) {
    runtime.logger.warn('[llm-gateway] native route resolution failed:', err);
  }

  const routedModel = route?.primaryModel || requestedModel;
  const maxFallbackModels = Math.min(8, Math.max(0, runtime.config.maxFallbackModels ?? 3));
  const routeModels = [routedModel, ...(route?.fallbackModels ?? [])]
    .filter((m): m is string => typeof m === 'string' && m.length > 0)
    .filter((m, i, all) => all.indexOf(m) === i)
    .slice(0, maxFallbackModels + 1);

  const candidates: Candidate[] = [];
  let resolutionError: GatewayResolutionError | null = null;
  for (const routeModel of routeModels) {
    try {
      const resolved = await runtime.hooks.resolveUpstream(principal, routeModel);
      candidates.push(...resolved.map((descriptor) => ({ descriptor, routeModel })));
    } catch (err) {
      runtime.logger.warn(`[llm-gateway] native upstream resolution failed for ${routeModel}:`, err);
      if (!resolutionError && err instanceof GatewayResolutionError) resolutionError = err;
    }
  }
  return { candidates, routedModel, resolutionError };
}

export async function handleLanguageModel(
  runtime: HandlerRuntime,
  req: LanguageModelRequest,
): Promise<Response> {
  const requestId = newRequestId();
  const { hooks, logger } = runtime;

  const noop = (): number => 0;
  const step = (): void => undefined;

  const token = req.authorization?.match(/^Bearer\s+(\S.*)$/i)?.[1]?.trim() ?? null;
  if (!token) {
    return gatewayErrorResponse(401, {
      message: 'Missing bearer token',
      code: 'missing_token',
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId,
      suggestion: 'Sign in again or provide a valid API token, then retry.',
    });
  }

  // Decode BEFORE billing so a malformed request fails fast without touching the
  // wallet.
  let decoded: DecodedLanguageModelRequest;
  try {
    const body = JSON.parse(req.rawBody) as unknown;
    decoded = decodeLanguageModelRequest({ headers: req.header, body });
  } catch (err) {
    const status = err instanceof LanguageModelRequestError ? err.status : 400;
    return gatewayErrorResponse(status, {
      message: err instanceof Error ? err.message : 'Invalid language-model request',
      code: 'invalid_request',
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId,
      suggestion: 'Correct the request headers/body and retry.',
    });
  }

  const gate = await admit(hooks, token, noop, step);
  if (!gate.ok) {
    refundBillingHold(runtime, gate.principal, requestId);
    return gatewayErrorResponse(gate.status, {
      message: gate.message ?? 'Unauthorized',
      code: gate.errorCode,
      provider: '',
      requestedModel: decoded.headers.modelId,
      resolvedModel: decoded.headers.modelId,
      requestId,
      suggestion:
        gate.status === 401
          ? 'Sign in again or provide a valid API token, then retry.'
          : 'Check account billing and budget settings, or use another available model.',
    });
  }
  const principal = gate.principal;

  const { candidates, routedModel, resolutionError } = await resolveCandidates(
    runtime,
    principal,
    decoded,
  );
  if (candidates.length === 0) {
    refundBillingHold(runtime, principal, requestId);
    return gatewayErrorResponse(resolutionError ? 400 : 400, {
      message: resolutionError?.message ?? `No upstream configured for model "${routedModel}"`,
      code: resolutionError?.code ?? 'model_unavailable',
      provider: '',
      requestedModel: decoded.headers.modelId,
      resolvedModel: routedModel,
      requestId,
      suggestion:
        resolutionError?.suggestion ??
        'Choose another model or connect the required provider, then retry.',
    });
  }

  // Phase 1: dispatch the FIRST candidate (see the file header for the deferred
  // mid-stream failover seam).
  const { descriptor } = candidates[0];

  // Honor a host-supplied fetch (production middleware, or a test double) on the
  // sole dispatch path, exactly like the chat handler does via callUpstream.
  const fetchImpl = runtime.fetchImpl;
  const model = resolveAiModel(descriptor, {}, {
    extraHeaders: { 'x-kortix-request-id': requestId },
    ...(fetchImpl ? { fetch: (input, init) => fetchImpl(String(input), init ?? {}) } : {}),
  });

  const usedModel = descriptor.resolvedModel || decoded.headers.modelId;

  const settle = async (usage: NativeBillingUsage): Promise<void> => {
    const markup = descriptor.billingMode === 'none' ? 0 : descriptor.markup;
    const { upstreamCost, finalCost } = calculateCost(
      usedModel,
      {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      markup,
      undefined,
      descriptor.pricing,
    );
    const billedTotal = usage.promptTokens + usage.completionTokens;
    if (billedTotal > 0 || principal.billingHold) {
      const event: UsageEvent = {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        accountId: principal.accountId,
        actorUserId: principal.userId,
        projectId: principal.projectId,
        sessionId: principal.sessionId,
        provider: descriptor.provider,
        model: usedModel,
        upstreamCost,
        finalCost,
        billingMode: descriptor.billingMode,
        streaming: decoded.headers.streaming,
        requestId,
        ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
      };
      try {
        await hooks.recordUsage(event);
      } catch (err) {
        logger.warn(`[llm-gateway] native recordUsage failed for ${requestId}:`, err);
      }
    }
  };

  const ctx = { model: usedModel, provider: descriptor.provider };

  try {
    // biome-ignore lint/suspicious/noExplicitAny: decoded.call is the AI-SDK
    // CallSettings-shaped args (messages/tools/providerOptions/...), forwarded
    // to streamText verbatim; the exact union is validated by the SDK at runtime.
    const result = streamText({
      model,
      system: decoded.call.system,
      messages: decoded.call.messages,
      tools: decoded.call.tools,
      toolChoice: decoded.call.toolChoice,
      temperature: decoded.call.temperature,
      topP: decoded.call.topP,
      topK: decoded.call.topK,
      frequencyPenalty: decoded.call.frequencyPenalty,
      presencePenalty: decoded.call.presencePenalty,
      stopSequences: decoded.call.stopSequences,
      maxOutputTokens: decoded.call.maxOutputTokens,
      seed: decoded.call.seed,
      providerOptions: decoded.call.providerOptions,
      maxRetries: 0,
      abortSignal: req.signal,
      onError: () => {
        /* surfaced as an `error` part through fullStream */
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    guardAgainstUnhandledResultRejections(result);

    let settled: NativeBillingUsage | null = null;
    const stream = aiGatewaySseFromFullStream(
      result.fullStream as AsyncIterable<{ type: string; [k: string]: unknown }>,
      ctx,
      {
        onUsage: (usage) => {
          settled = usage;
          void settle(usage);
        },
      },
    );
    // If the stream ends without ever reporting usage (should not happen —
    // aiGatewaySseFromFullStream always reports once), refund any hold.
    void Promise.resolve().then(() => {
      if (!settled && principal.billingHold) refundBillingHold(runtime, principal, requestId);
    });

    return sseResponse(stream);
  } catch (err) {
    refundBillingHold(runtime, principal, requestId);
    const transportError = toTransportError(err, descriptor.provider);
    logger.warn(`[llm-gateway] native dispatch failed for ${requestId}:`, transportError);
    return gatewayErrorResponse(502, {
      message: errorMessage(transportError),
      code: 'upstream_unreachable',
      provider: descriptor.provider,
      requestedModel: decoded.headers.modelId,
      resolvedModel: usedModel,
      requestId,
      suggestion: 'Retry the request. If the error continues, switch to another model.',
    });
  }
}
