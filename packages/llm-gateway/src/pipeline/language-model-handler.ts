import type { AuthedPrincipal, ModelRoutePlan, UpstreamDescriptor, UsageEvent } from '../domain';
import { GatewayResolutionError, UpstreamHttpError } from '../errors';
import { parseUpstreamErrorBody } from '../http/parse-upstream-error';
import {
  type FullStreamPart,
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
import { MAX_INVALID_COMPLETION_ATTEMPTS_PER_CANDIDATE, admit } from './handler';
import type { HandlerRuntime } from './handler';
import { type NativeFailure, runNativeFailover } from './native-failover';

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
// PHASE 2 — per-turn provider failover + empty-completion retries (this file):
//   - `runNativeFailover` (native-failover.ts) iterates the resolved candidates,
//     PROBES each stream for the first content part, and commits the first that
//     serves — mirroring `runFailover`'s limit-vs-terminal classification and
//     handler.ts's empty-completion retry loop, but over typed `fullStream`
//     parts instead of OpenAI SSE bytes. ONLY the committed candidate is billed.
//
// DEFERRED to Phase 3 (documented, NOT silently missing):
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
): Promise<{
  candidates: Candidate[];
  routedModel: string;
  resolutionError: GatewayResolutionError | null;
}> {
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
      runtime.logger.warn(
        `[llm-gateway] native upstream resolution failed for ${routeModel}:`,
        err,
      );
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

  // Honor a host-supplied fetch (production middleware, or a test double) on
  // every candidate attempt, exactly like the chat handler does via callUpstream.
  const fetchImpl = runtime.fetchImpl;

  // Open a fresh streamText for ONE candidate. Called once per attempt — an
  // empty-completion retry calls it again to get a new stream. `onError`
  // swallows the SDK's own rejection path; the error is surfaced as an `error`
  // part through `fullStream`, which the failover probe classifies.
  const startStream = (candidate: Candidate): AsyncIterable<FullStreamPart> => {
    const model = resolveAiModel(
      candidate.descriptor,
      {},
      {
        extraHeaders: { 'x-kortix-request-id': requestId },
        ...(fetchImpl ? { fetch: (input, init) => fetchImpl(String(input), init ?? {}) } : {}),
      },
    );
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
    return result.fullStream as AsyncIterable<FullStreamPart>;
  };

  const failover = await runNativeFailover<Candidate>({
    candidates,
    providerOf: (candidate) => candidate.descriptor.provider,
    startStream,
    toTransportError,
    maxInvalidAttempts: MAX_INVALID_COMPLETION_ATTEMPTS_PER_CANDIDATE,
    logger,
    requestId,
    ...(typeof runtime.config.streamProbeTimeoutMs === 'number' &&
    runtime.config.streamProbeTimeoutMs > 0
      ? { commitDeadlineMs: runtime.config.streamProbeTimeoutMs }
      : {}),
  });

  if (failover.kind === 'failed') {
    // Nothing was relayed to the client — refund any admission hold and surface
    // the failure as an HTTP error response (mirrors the chat path, which
    // returns a non-200 JSON body when no candidate ever served).
    refundBillingHold(runtime, principal, requestId);
    const { status, code, message } = describeNativeFailure(failover);
    logger.warn(`[llm-gateway] native failover exhausted for ${requestId}: ${message}`);
    return gatewayErrorResponse(status, {
      message,
      code,
      provider: failover.provider,
      requestedModel: decoded.headers.modelId,
      resolvedModel: routedModel,
      requestId,
      suggestion:
        status === 401 || status === 402 || status === 403
          ? 'Check the provider credentials, billing, and model access, or switch to another model.'
          : 'Retry the request. If the error continues, switch to another model.',
    });
  }

  // A candidate committed: bill ONLY it (its own descriptor/pricing), and
  // serialize ITS stream (the buffered probe parts + the rest). A candidate the
  // failover skipped/failed over never reaches this settle — it is never billed.
  const { descriptor } = failover.candidate;
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

  let settled: NativeBillingUsage | null = null;
  const stream = aiGatewaySseFromFullStream(failover.stream, ctx, {
    onUsage: (usage) => {
      settled = usage;
      void settle(usage);
    },
  });
  // If the stream ends without ever reporting usage (should not happen —
  // aiGatewaySseFromFullStream always reports once), refund any hold.
  void Promise.resolve().then(() => {
    if (!settled && principal.billingHold) refundBillingHold(runtime, principal, requestId);
  });

  return sseResponse(stream);
}

// Map a `runNativeFailover` failure into the HTTP status/code/message the client
// sees. Mirrors runFailover's terminal-4xx vs unreachable-5xx split and pulls
// the real upstream message out of an `UpstreamHttpError` body via the SAME
// `parseUpstreamErrorBody` the byte path uses.
function describeNativeFailure(failure: NativeFailure): {
  status: number;
  code: string;
  message: string;
} {
  const err = failure.transportError;
  if (err instanceof UpstreamHttpError) {
    const parsed = parseUpstreamErrorBody(err.body);
    if (err.status >= 400 && err.status < 500) {
      const code =
        parsed.code === 'context_length_exceeded'
          ? 'context_length_exceeded'
          : 'upstream_client_error';
      return { status: err.status, code, message: parsed.message };
    }
    return { status: 502, code: 'upstream_unreachable', message: parsed.message };
  }
  if (failure.reason === 'empty') {
    return {
      status: 502,
      code: 'empty_completion',
      message: 'All upstream candidates returned an empty completion',
    };
  }
  return { status: 502, code: 'upstream_unreachable', message: failure.message };
}
