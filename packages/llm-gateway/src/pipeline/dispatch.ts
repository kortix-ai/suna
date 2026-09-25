import type {
  GatewayAttemptFailure,
  GatewayLogger,
  ModelFallbackCondition,
  ModelGenerationDefaults,
  UpstreamDescriptor,
} from '../domain';
import { ClientAbortError, UpstreamHttpError, isUnknownParameterRejection } from '../errors';
import { type CallUpstreamOptions, type FetchImpl, callUpstream } from '../http';
import { noteBedrockOpenAiRejectsReasoningEffort } from '../transports/ai-sdk/request';
import { resolveTransportKind } from '../transports/route-kind';
import { clampRetryAfterSeconds } from './error-response';
import { applyGenerationDefaults } from './generation-defaults';
import { publicUpstreamError, shownModel, shownProvider } from './public-identity';

/**
 * Dispatch runs one request's attempt plan: the resolved candidates of the
 * routed model, then the candidates of each configured fallback model, in
 * order, under one retry policy.
 *
 * An attempt fails when the transport throws or answers non-2xx. Every
 * transport reports a failure before it serves any output: an HTTP status for
 * openai-compat, and a thrown error for an AI SDK stream that failed before its
 * first output part (see transports/ai-sdk openStream). After a failure the
 * next attempt is, in this order:
 *
 * 1. A variant of the same candidate: without `reasoning_effort` when a Bedrock
 *    model refuses that parameter, or the `global.` then `us.` inference
 *    profile when Bedrock refuses a bare model id.
 * 2. The next candidate of the same model: the next pool key after a 429, or
 *    the next provider when the candidates opted into `failover`.
 * 3. The first candidate of the next fallback model, when the failure matches
 *    `fallbackOn`. A BYOK request never falls back to a Kortix-billed model.
 *
 * A client that left stops the plan. The final failure is returned unchanged
 * for the caller to present.
 */

export interface DispatchPlan {
  /** The routed model. `candidates` are its resolved upstreams, best first. */
  model: string;
  candidates: readonly UpstreamDescriptor[];
  fallbackModels?: readonly string[];
  fallbackOn?: ModelFallbackCondition;
  /** Generation defaults for a model. Applied per attempt, so a fallback model gets its own. */
  defaultsFor?: (model: string) => ModelGenerationDefaults | undefined;
}

export type Send = (
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  opts: CallUpstreamOptions,
) => Promise<Response>;

export interface DispatchContext {
  requestId: string;
  logger: GatewayLogger;
  fetchImpl: FetchImpl;
  signal?: AbortSignal;
  /** Resolves a fallback model's candidates. Called only when the plan reaches that model. */
  resolveCandidates: (model: string) => Promise<UpstreamDescriptor[]>;
  notePoolRateLimit?: (secretId: string, seconds: number) => Promise<void>;
  /** The transport. Defaults to `callUpstream`. */
  send?: Send;
}

interface DispatchProgress {
  /** The candidate of the last attempt: the one that served, or the last that failed. */
  descriptor: UpstreamDescriptor;
  /** The model of the last attempt: the routed model or a fallback model. */
  model: string;
  attempts: number;
  candidatesTried: string[];
  attemptFailures: GatewayAttemptFailure[];
}

/** `response` when the last attempt answered (2xx, or the final non-2xx); `error` when it threw. */
export type DispatchOutcome = DispatchProgress &
  ({ response: Response; error?: undefined } | { error: unknown; response?: undefined });

/** Deadline for provider response headers on a direct request. See `withUpstreamHeadersTimeout`. */
export const UPSTREAM_HEADERS_TIMEOUT_MS =
  Number(process.env.GATEWAY_UPSTREAM_HEADERS_TIMEOUT_MS) || 90_000;
const SYNTHETIC_STREAMING_HEADERS_TIMEOUT_MS =
  Number(process.env.GATEWAY_STREAMING_UPSTREAM_HEADERS_TIMEOUT_MS) || 5 * 60_000;

/**
 * The provider response-header deadline for one attempt.
 *
 * AI SDK streams get five minutes because their synthetic gateway headers keep
 * the client alive while a large model prefill still waits on provider headers.
 */
export function upstreamHeadersTimeoutMs(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
  streaming: boolean,
  limits: { direct: number; syntheticStreaming: number } = {
    direct: UPSTREAM_HEADERS_TIMEOUT_MS,
    syntheticStreaming: SYNTHETIC_STREAMING_HEADERS_TIMEOUT_MS,
  },
): number {
  const transportKind = resolveTransportKind(body, descriptor);
  const hasSyntheticStreamingHeaders =
    streaming && transportKind !== 'openai-compat' && transportKind !== 'custom';
  return hasSyntheticStreamingHeaders ? limits.syntheticStreaming : limits.direct;
}

/**
 * Bounds the time to the provider's response HEADERS.
 *
 * A provider that accepts the TCP connection and never answers would otherwise
 * pin an admission reservation while Cloudflare gives the caller a 524 at 100 s.
 * This fires first, so the caller gets a typed 503 it can retry. Headers only:
 * once the provider fetch resolves, the timer is cleared and `relayStream`'s
 * heartbeat plus inactivity budget govern the response body.
 */
export function withUpstreamHeadersTimeout(
  fetchImpl: FetchImpl,
  timeoutMs: number = UPSTREAM_HEADERS_TIMEOUT_MS,
): FetchImpl {
  return async (input, init) => {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('Provider response headers timed out', 'TimeoutError')),
      timeoutMs,
    );
    const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;

    try {
      return await fetchImpl(input, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The provider's own error, relayed with its status and a `retry-after` when it sent one. */
export function rawProviderError(error: UpstreamHttpError): Response {
  return new Response(error.body || JSON.stringify({ error: { message: error.message } }), {
    status: error.status,
    headers: {
      'content-type': 'application/json',
      ...(error.headers?.['retry-after'] ? { 'retry-after': error.headers['retry-after'] } : {}),
    },
  });
}

/** Fallback models beyond this many are ignored. The API accepts at most 8 per chain. */
const MAX_FALLBACK_MODELS = 8;

// 4xx statuses that mean "this upstream will not serve you now" rather than
// "the request is wrong". A `transient` fallback chain moves past these, every
// 5xx, and every failure without an HTTP status (network, timeout).
const LIMIT_STATUSES = new Set([402, 403, 429]);

// Cross-region inference profile prefixes to try, best first. `global.` serves
// every commercial region; `us.` is the widest regional profile.
const BEDROCK_PROFILE_PREFIXES = ['global.', 'us.'] as const;

interface Attempt {
  descriptor: UpstreamDescriptor;
  model: string;
  /** Set on the variant sent without `reasoning_effort`. */
  withoutEffort?: boolean;
  /** Set on an inference-profile variant: the bare id and the prefix index. */
  profile?: { bareId: string; index: number };
}

interface Failure {
  attempt: Attempt;
  status?: number;
  response?: Response;
  error?: unknown;
}

function isBedrock(descriptor: UpstreamDescriptor): boolean {
  return descriptor.kind === 'bedrock' || descriptor.provider === 'amazon-bedrock';
}

// A Bedrock descriptor whose resolved id carries no profile prefix — the only
// shape the inference-profile variant applies to.
function bedrockBareModelId(descriptor: UpstreamDescriptor): string | null {
  if (descriptor.kind !== 'bedrock') return null;
  const id = descriptor.resolvedModel;
  if (!id || /^(global|us|eu|jp|apac|au|ca|sa|us-gov)\./.test(id)) return null;
  return id;
}

// Bedrock's exact refusal of a bare id (ASCII and curly apostrophe both seen):
// "Invocation of model ID xai.grok-4.6 with on-demand throughput isn't
// supported. Retry your request with the ID or ARN of an inference profile".
// models.dev carries the bare id for every such model and the profile only for
// some, so the gateway derives the profile id itself.
function needsInferenceProfile(error: unknown): boolean {
  return (
    error instanceof UpstreamHttpError &&
    error.status === 400 &&
    /on-demand throughput isn.t supported/i.test(error.body)
  );
}

function isPoolPeer(head: UpstreamDescriptor, candidate: UpstreamDescriptor): boolean {
  return Boolean(head.poolSecretId && candidate.poolSecretId && candidate.provider === head.provider);
}

// Whether `candidate`, a later candidate of the same model, takes over after
// `failure`. Failover candidates take any failure; pool keys take a 429.
function peerTakesOver(head: UpstreamDescriptor, candidate: UpstreamDescriptor, failure: Failure): boolean {
  if (head.failover && candidate.failover) return true;
  return isPoolPeer(head, candidate) && failure.status === 429;
}

function fallbackTakesOver(on: ModelFallbackCondition, failure: Failure): boolean {
  if (on === 'any-error') return true;
  const { status } = failure;
  return status === undefined || status >= 500 || LIMIT_STATUSES.has(status);
}

function fallbackModelsOf(plan: DispatchPlan): string[] {
  const models = (plan.fallbackModels ?? []).filter(
    (model, index, all) =>
      typeof model === 'string' && model.length > 0 && model !== plan.model && all.indexOf(model) === index,
  );
  return models.slice(0, MAX_FALLBACK_MODELS);
}

function errorText(error: unknown): string {
  if (error instanceof UpstreamHttpError) return `${error.message} ${error.body}`;
  return error instanceof Error ? error.message : String(error);
}

function retryAfterOf(failure: Failure): string | null | undefined {
  if (failure.response) return failure.response.headers.get('retry-after');
  return failure.error instanceof UpstreamHttpError ? failure.error.headers?.['retry-after'] : undefined;
}

export async function dispatch(
  body: Record<string, unknown> | null,
  plan: DispatchPlan,
  ctx: DispatchContext,
): Promise<DispatchOutcome> {
  const { logger, requestId } = ctx;
  const send = ctx.send ?? callUpstream;
  const primary = plan.candidates[0];
  if (!primary || !body) throw new Error('dispatch needs a request body and at least one candidate');
  const fallbackModels = fallbackModelsOf(plan);

  const withDefaults = (source: Record<string, unknown>, attempt: Attempt): Record<string, unknown> => {
    const next = applyGenerationDefaults({ ...source, model: attempt.model }, plan.defaultsFor?.(attempt.model));
    if (!attempt.withoutEffort) return next;
    const { reasoning_effort: _dropped, ...stripped } = next;
    return stripped;
  };

  const first: Attempt = { descriptor: primary, model: plan.model };
  let firstBody: Record<string, unknown> | null = withDefaults(body, first);
  // The parsed request is kept for a later attempt only when the plan can
  // produce one; otherwise no reference outlives the first send, so a slow
  // provider does not pin a multi-MB multimodal body for the whole prefill.
  const retained: Record<string, unknown> | null =
    fallbackModels.length > 0 ||
    bedrockBareModelId(primary) !== null ||
    (isBedrock(primary) && typeof firstBody.reasoning_effort === 'string') ||
    plan.candidates
      .slice(1)
      .some((candidate) => (primary.failover ? candidate.failover : isPoolPeer(primary, candidate)))
      ? body
      : null;
  body = null;

  const attemptFailures: GatewayAttemptFailure[] = [];
  const candidatesTried: string[] = [];
  let attempts = 0;
  let earliestPoolRetryAt = Infinity;

  const label = (attempt: Attempt): string => {
    const { descriptor } = attempt;
    return [
      shownProvider(descriptor),
      attempt.model !== plan.model ? attempt.model : null,
      descriptor.poolSecretId ?? null,
      attempt.profile ? descriptor.resolvedModel : null,
    ].filter(Boolean).join(':');
  };

  const run = async (attempt: Attempt): Promise<Response | Failure> => {
    attempts += 1;
    candidatesTried.push(label(attempt));
    let payload: Record<string, unknown> | null = firstBody ?? withDefaults(retained!, attempt);
    firstBody = null;
    const fetchImpl = withUpstreamHeadersTimeout(
      ctx.fetchImpl,
      upstreamHeadersTimeoutMs(payload, attempt.descriptor, payload.stream === true),
    );
    try {
      const pending = send(payload, attempt.descriptor, { fetchImpl, signal: ctx.signal, requestId });
      // The transport has serialized or translated the body synchronously up
      // to its first await; this frame no longer needs it.
      payload = null;
      const response = await pending;
      return response.ok ? response : { attempt, status: response.status, response };
    } catch (error) {
      return { attempt, status: error instanceof UpstreamHttpError ? error.status : undefined, error };
    }
  };

  const notePoolRateLimit = async (failure: Failure): Promise<void> => {
    const secretId = failure.attempt.descriptor.poolSecretId;
    if (!secretId || failure.status !== 429) return;
    const seconds = clampRetryAfterSeconds(retryAfterOf(failure)) ?? 30;
    earliestPoolRetryAt = Math.min(earliestPoolRetryAt, Date.now() + seconds * 1000);
    if (!ctx.notePoolRateLimit) return;
    try {
      await ctx.notePoolRateLimit(secretId, seconds);
    } catch (error) {
      logger.error('[gateway] provider key cooldown could not be recorded', {
        secretId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Records a failure the plan moves past. The final failure is not recorded
  // here: the caller presents it and traces it as the request's own error.
  const movePast = async (failure: Failure, next: Attempt): Promise<void> => {
    const { descriptor, model } = failure.attempt;
    const message = failure.response
      ? (await failure.response.text().catch(() => '')).slice(0, 500)
      : errorText(failure.error);
    // Server log: the one place the upstream identity and text are kept.
    logger.warn(
      `[gateway] ${requestId}: ${descriptor.provider} failed for ${descriptor.resolvedModel ?? model} (${failure.status ?? 'network error'}); trying ${label(next)}: ${message.slice(0, 300)}`,
    );
    const shown = descriptor.publicProvider ? publicUpstreamError(failure.status ?? 0, message, model) : null;
    attemptFailures.push({
      attempt: attemptFailures.length + 1,
      provider: shownProvider(descriptor),
      routeModel: model,
      resolvedModel: shownModel(descriptor, model),
      stage: 'dispatch',
      status: failure.status,
      code: shown ? shown.code : failure.status ?? 'network_error',
      message: shown ? shown.message : message,
    });
  };

  // Plan position: the model being tried and the index of the current candidate.
  let modelIndex = 0;
  let model = plan.model;
  let candidates: readonly UpstreamDescriptor[] = plan.candidates;
  let index = 0;

  const variantAfter = (failure: Failure): Attempt | null => {
    const { attempt } = failure;
    const { descriptor } = attempt;
    const effortRefused =
      !attempt.withoutEffort &&
      isBedrock(descriptor) &&
      isUnknownParameterRejection(failure.error, 'reasoning_effort');
    if (effortRefused) {
      // Remembered, so every later request to this model skips the field.
      noteBedrockOpenAiRejectsReasoningEffort(descriptor.resolvedModel ?? attempt.model);
      return { ...attempt, withoutEffort: true };
    }
    if (!needsInferenceProfile(failure.error)) return null;
    const bareId = attempt.profile?.bareId ?? bedrockBareModelId(descriptor);
    const prefixIndex = attempt.profile ? attempt.profile.index + 1 : 0;
    const prefix = BEDROCK_PROFILE_PREFIXES[prefixIndex];
    if (!bareId || !prefix) return null;
    return {
      ...attempt,
      descriptor: { ...descriptor, resolvedModel: `${prefix}${bareId}` },
      profile: { bareId, index: prefixIndex },
    };
  };

  const resolveFallback = async (fallbackModel: string): Promise<readonly UpstreamDescriptor[]> => {
    let resolved: UpstreamDescriptor[];
    try {
      resolved = await ctx.resolveCandidates(fallbackModel);
    } catch (error) {
      logger.warn(
        `[gateway] ${requestId}: fallback model ${fallbackModel} is unavailable: ${errorText(error).slice(0, 300)}`,
      );
      return [];
    }
    // A failed BYOK request must fail as BYOK; it never becomes a Kortix charge.
    if (primary.billingMode !== 'none') return resolved;
    const byok = resolved.filter((candidate) => candidate.billingMode === 'none');
    if (resolved.length > byok.length && !byok.length) {
      logger.warn(
        `[gateway] ${requestId}: fallback model ${fallbackModel} skipped: a BYOK request does not fall back to a Kortix-billed model`,
      );
    }
    return byok;
  };

  const nextAttempt = async (failure: Failure): Promise<Attempt | null> => {
    if (!retained) return null;
    const variant = variantAfter(failure);
    if (variant) return variant;
    const head = candidates[0]!;
    for (let next = index + 1; next < candidates.length; next += 1) {
      if (!peerTakesOver(head, candidates[next]!, failure)) continue;
      index = next;
      return { descriptor: candidates[next]!, model };
    }
    while (modelIndex < fallbackModels.length && fallbackTakesOver(plan.fallbackOn ?? 'transient', failure)) {
      model = fallbackModels[modelIndex]!;
      modelIndex += 1;
      candidates = await resolveFallback(model);
      index = 0;
      if (candidates.length) return { descriptor: candidates[0]!, model };
    }
    return null;
  };

  const finish = (failure: Failure): DispatchOutcome => {
    const { descriptor, model: failedModel } = failure.attempt;
    const progress = { descriptor, model: failedModel, attempts, candidatesTried, attemptFailures };
    const pooled429 = Boolean(descriptor.poolSecretId) && failure.status === 429;
    if (!pooled429) {
      return failure.response ? { ...progress, response: failure.response } : { ...progress, error: failure.error };
    }
    // Every pool key is rate-limited: tell the client when the first one frees up.
    const limited = failure.response ?? rawProviderError(failure.error as UpstreamHttpError);
    const headers = new Headers(limited.headers);
    headers.set('retry-after', String(Math.max(1, Math.ceil((earliestPoolRetryAt - Date.now()) / 1000))));
    return {
      ...progress,
      response: new Response(limited.body, { status: limited.status, statusText: limited.statusText, headers }),
    };
  };

  let attempt = first;
  for (;;) {
    const result = await run(attempt);
    if (result instanceof Response) {
      const { descriptor, model: servedModel } = attempt;
      return { descriptor, model: servedModel, attempts, candidatesTried, attemptFailures, response: result };
    }
    if (result.error instanceof ClientAbortError || ctx.signal?.aborted) return finish(result);
    await notePoolRateLimit(result);
    const next = await nextAttempt(result);
    if (!next) return finish(result);
    await movePast(result, next);
    attempt = next;
  }
}
