import type { AuthorizeResult, GatewayAttemptFailure, ModelRoutePlan, UpstreamDescriptor } from '../domain';
import { GatewayResolutionError } from '../errors';
import { upstreamFetch } from '../upstream-fetch';
import { calculateCost } from '../usage/pricing';
import { fallbackModelsOf } from './dispatch';
import { gatewayErrorBody } from './error-response';
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type ImageAttempt,
  type ImageFailure,
  type ImageInput,
  imageAdapterFor,
} from './image-adapters';
import { shownModel, shownProvider } from './public-identity';
import { type HandlerRuntime, authorize, bearer, identity, refundHold, requestId } from './simple-handler';
import { createTraceEmitter } from './trace';

export type ImageOperation = 'generations' | 'edits';

export interface ImageRequest {
  authorization: string | undefined;
  rawBody: string;
  operation: ImageOperation;
  signal?: AbortSignal;
}

const MAX_REFERENCE_IMAGES = 5;
const UPSTREAM_TIMEOUT_MS = 300_000;
/** ChatGPT image-limit headers, relayed on success and on 429 so a client can show when the limit resets. */
const LIMIT_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-primary-reset-after-seconds',
  'x-codex-primary-window-minutes',
];
const NO_IMAGE_MODEL_SUGGESTION = 'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.';

/** Why one candidate did not answer. The last one is the request's answer. */
interface Refusal {
  status: number;
  code: string;
  message: string;
  suggestion: string;
  retryAfter?: number;
  headers?: Record<string, string>;
}

/**
 * The request in the gateway's own contract (U-D1). Unknown keys never reach
 * an upstream and `n` is always 1. Returns an error message for an invalid body.
 */
function imageInput(raw: string, operation: ImageOperation): { input: ImageInput; model: string } | string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 'Invalid JSON body';
  }
  if (!parsed || typeof parsed !== 'object') return 'Invalid JSON body';
  if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) return '`prompt` is required.';
  const input: ImageInput = { operation, prompt: parsed.prompt };
  if (parsed.aspect_ratio !== undefined) {
    if (!ASPECT_RATIOS.includes(parsed.aspect_ratio as AspectRatio)) {
      return `\`aspect_ratio\` must be one of ${ASPECT_RATIOS.join(', ')}.`;
    }
    input.aspectRatio = parsed.aspect_ratio as AspectRatio;
  }
  if (typeof parsed.quality === 'string') input.quality = parsed.quality;
  if (typeof parsed.background === 'string') input.background = parsed.background;
  if (operation === 'edits') {
    const images = parsed.images;
    if (!Array.isArray(images) || images.length < 1 || images.length > MAX_REFERENCE_IMAGES) {
      return `\`images\` needs 1 to ${MAX_REFERENCE_IMAGES} reference images.`;
    }
    const urls = images.map((image) => (image as { image_url?: unknown } | null)?.image_url);
    if (!urls.every((url): url is string => typeof url === 'string' && url.length > 0)) {
      return 'Every image needs an `image_url`.';
    }
    input.images = urls;
  }
  const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : 'auto';
  return { input, model };
}

function limitHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LIMIT_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Seconds until the image limit resets: `retry-after`, else the ChatGPT reset header, else 60. */
function restSeconds(upstream: Headers): number {
  for (const name of ['retry-after', 'x-codex-primary-reset-after-seconds']) {
    const seconds = Number.parseFloat(upstream.get(name) ?? '');
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  return 60;
}

const SAFETY_REFUSAL = /moderation|content[_ ]policy|safety/i;

/**
 * What the client hears when `descriptor` answered without an image. A
 * managed model's upstream text never reaches the client (public identity).
 */
function refusalFor(failure: ImageFailure, descriptor: UpstreamDescriptor, model: string, provider: string): Refusal {
  const name = descriptor.provider === 'openai-codex' ? 'ChatGPT' : provider;
  if (failure.status === 429) {
    return {
      status: 429,
      code: 'image_rate_limited',
      message: `The ${name} image limit is reached.`,
      suggestion: 'Wait for the limit to reset, then retry.',
      retryAfter: restSeconds(failure.headers),
      headers: limitHeaders(failure.headers),
    };
  }
  if (failure.status === 401) {
    return descriptor.provider === 'openai-codex'
      ? { status: 401, code: 'provider_reauth_required', message: 'The ChatGPT login expired.', suggestion: 'Reconnect ChatGPT in Models, then retry.' }
      : { status: 401, code: 'provider_reauth_required', message: `${name} refused the credential.`, suggestion: `Check the ${name} key in project settings, then retry.` };
  }
  const message = descriptor.publicProvider ? '' : failure.message;
  const safety = failure.status < 500 && SAFETY_REFUSAL.test(`${failure.code ?? ''} ${message}`);
  return {
    status: failure.status >= 500 ? 502 : failure.status,
    code: 'image_upstream_error',
    message: failure.code === 'no_image' ? `${model} returned no image.` : message || `${name} answered ${failure.status}.`,
    suggestion: safety
      ? 'Change the prompt or the reference images, then retry.'
      : `Retry, or check the ${name} connection in project settings.`,
  };
}

/** The models to try, in order: the host's image plan, or the named model alone. */
function plannedModels(route: ModelRoutePlan | null, requestedModel: string): string[] {
  // A host without image routing answers an image request with a chat plan;
  // its models cannot generate images, so it counts as no plan.
  if (route?.policyId === 'image' && route.primaryModel) {
    return [route.primaryModel, ...fallbackModelsOf({ model: route.primaryModel, fallbackModels: route.fallbackModels })];
  }
  return requestedModel === 'auto' ? [] : [requestedModel];
}

export async function handleImageRequest(runtime: HandlerRuntime, req: ImageRequest): Promise<Response> {
  const { hooks, logger } = runtime;
  const fetchImpl = runtime.fetchImpl ?? upstreamFetch;
  const id = requestId();
  const startedMs = Date.now();
  const emit = createTraceEmitter(hooks, logger, id, new Date().toISOString(), startedMs);
  const operation = `images.${req.operation}`;
  let requestedModel = '';
  let resolvedModel = '';
  let provider = '';
  let attempts = 0;
  const candidatesTried: string[] = [];
  const attemptFailures: GatewayAttemptFailure[] = [];

  const fail = (refusal: Refusal): Response => {
    const { status, retryAfter } = refusal;
    const body = gatewayErrorBody({
      message: refusal.message,
      code: refusal.code,
      provider,
      requestedModel,
      resolvedModel,
      requestId: id,
      suggestion: refusal.suggestion,
      responseStatus: status,
    });
    return new Response(JSON.stringify(retryAfter !== undefined ? { ...body, retry_after: retryAfter } : body), {
      status,
      headers: {
        'content-type': 'application/json',
        ...(retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
        ...refusal.headers,
      },
    });
  };

  const token = bearer(req.authorization);
  if (!token) {
    return fail({
      status: 401,
      code: 'missing_token',
      message: 'Missing bearer token',
      suggestion: 'Provide a valid gateway key or account token.',
    });
  }

  let admission: AuthorizeResult;
  try {
    admission = await authorize(hooks, token);
  } catch (error) {
    logger.error(`[gateway] ${id}: admission control unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return fail({
      status: 503,
      code: 'admission_unavailable',
      message: 'Gateway admission control is unavailable',
      suggestion: 'Retry the request.',
      retryAfter: 5,
    });
  }

  if (!admission.ok) {
    const message = admission.message ?? 'Request not allowed';
    if (admission.principal) {
      emit({
        ...identity(admission.principal),
        status: admission.status,
        ok: false,
        errorCode: admission.errorCode,
        errorMessage: message,
        request: null,
        response: null,
        metadata: { operation },
      });
    }
    return fail({ status: admission.status, code: admission.errorCode, message, suggestion: 'Sign in again or check the account, then retry.' });
  }
  let principal = admission.principal;

  const trace = (fields: { status: number; ok: boolean; errorCode?: string; errorMessage?: string }, extra = {}) =>
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel,
      provider,
      billingMode: 'none',
      attempts,
      candidatesTried,
      ...(attemptFailures.length ? { attemptFailures } : {}),
      ...fields,
      ...extra,
      // Never the prompt or the image bytes.
      request: null,
      response: null,
      metadata: { operation },
    });
  /** Every unanswered exit after admission: return any wallet hold, trace, answer. */
  const refuse = (refusal: Refusal): Response => {
    refundHold(hooks, principal, logger);
    trace({ status: refusal.status, ok: false, errorCode: refusal.code, errorMessage: refusal.message });
    return fail(refusal);
  };

  const parsed = imageInput(req.rawBody, req.operation);
  req.rawBody = '';
  if (typeof parsed === 'string') {
    return refuse({ status: 400, code: 'invalid_request', message: parsed, suggestion: 'Fix the request body and retry.' });
  }
  const { input } = parsed;
  requestedModel = parsed.model;

  let route: ModelRoutePlan | null;
  try {
    route = (await hooks.resolveRoute?.(principal, {
      requestedModel,
      requires: { imageInput: req.operation === 'edits', imageOutput: true },
    })) ?? null;
    emit.mark('routed');
  } catch (error) {
    if (error instanceof GatewayResolutionError) {
      return refuse({ status: 400, code: error.code, message: error.message, suggestion: error.suggestion });
    }
    logger.error(`[gateway] ${id}: image routing unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return refuse({ status: 502, code: 'routing_unavailable', message: 'Model routing is unavailable', suggestion: 'Retry the request.' });
  }
  const models = plannedModels(route, requestedModel);
  if (!models.length) {
    return refuse({
      status: 400,
      code: 'image_model_unavailable',
      message: 'No image model is available for this project.',
      suggestion: NO_IMAGE_MODEL_SUGGESTION,
    });
  }

  // One wallet admission per request, before the first Kortix-billed
  // candidate, exactly as chat takes it. A hold is settled with the usage
  // event or returned by `refuse`.
  let charge: Promise<Refusal | null> | null = null;
  const admitCharge = () =>
    (charge ??= (async () => {
      if (principal.billingHold) return null;
      try {
        const billing = await hooks.assertBillingActive(principal.accountId);
        if (billing?.holdUsd) principal = { ...principal, billingHold: { amountUsd: billing.holdUsd } };
        return null;
      } catch (error) {
        const reason = (error as { reason?: unknown })?.reason;
        return {
          status: 402,
          code: typeof reason === 'string' ? reason : 'subscription_required',
          message: error instanceof Error ? error.message : 'Billing inactive',
          suggestion: 'Check your subscription or add credits, then retry.',
        };
      }
    })());

  const signal = req.signal
    ? AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
    : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  /** A stopped client or the 300 s budget ends the request; no other model is tried. */
  const stopped = (): Refusal | null => {
    if (req.signal?.aborted) {
      return { status: 499, code: 'client_aborted', message: 'The client cancelled the request.', suggestion: 'Retry the request.' };
    }
    if (signal.aborted) {
      return { status: 504, code: 'image_timeout', message: 'Image generation timed out.', suggestion: 'Retry the request.' };
    }
    return null;
  };
  let refreshed = false;
  let last: Refusal | undefined;
  const failed = (model: string, refusal: Refusal, stage: GatewayAttemptFailure['stage'] = 'dispatch') => {
    last = refusal;
    attemptFailures.push({
      attempt: attemptFailures.length + 1,
      provider,
      routeModel: model,
      resolvedModel,
      stage,
      status: refusal.status,
      code: refusal.code,
      message: refusal.message,
    });
  };

  emit.mark('dispatch');
  for (const model of models) {
    resolvedModel = model;
    provider = '';
    let candidates: UpstreamDescriptor[];
    try {
      candidates = await hooks.resolveUpstream(principal, model);
    } catch (error) {
      const resolution = error instanceof GatewayResolutionError ? error : null;
      failed(model, {
        status: resolution?.code === 'provider_pool_rate_limited' ? 429 : 400,
        code: resolution?.code ?? 'model_unavailable',
        message: resolution?.message ?? `No provider is configured for model "${model}"`,
        suggestion: resolution?.suggestion ?? 'Connect the provider or choose another model.',
        retryAfter: resolution?.retryAfterSeconds,
      }, 'resolve');
      continue;
    }
    if (!candidates.length) {
      failed(model, {
        status: 400,
        code: 'model_unavailable',
        message: `No provider is configured for model "${model}"`,
        suggestion: 'Connect the provider or choose another model.',
      }, 'resolve');
      continue;
    }

    // Pooled accounts of one model: only a 429 moves to the next one (R6).
    for (let descriptor of candidates) {
      provider = shownProvider(descriptor);
      resolvedModel = shownModel(descriptor, model);
      const adapter = imageAdapterFor(descriptor);
      if (!adapter) {
        failed(model, {
          status: 400,
          code: 'image_model_unsupported',
          message: `${model} cannot generate images through Kortix.`,
          suggestion: 'Choose an image model, or use auto.',
        });
        break;
      }
      if (descriptor.billingMode !== 'none') {
        // Kortix never serves a managed image it cannot charge.
        if (!descriptor.pricing) {
          failed(model, {
            status: 400,
            code: 'image_model_unpriced',
            message: `${model} has no image price.`,
            suggestion: 'Choose another image model, or use auto.',
          });
          break;
        }
        const denied = await admitCharge();
        if (denied) {
          failed(model, denied);
          break;
        }
      }

      const send = (target: UpstreamDescriptor) => {
        attempts += 1;
        candidatesTried.push(`${provider}:${model}`);
        return adapter(target, input, { fetchImpl, signal, requestId: id });
      };
      let attempt: ImageAttempt;
      try {
        attempt = await send(descriptor);
        if (!attempt.ok && attempt.status === 401 && descriptor.refreshableCredential && hooks.refreshCredential && !refreshed) {
          refreshed = true;
          const fresh = await hooks.refreshCredential(principal, descriptor);
          if (fresh) {
            descriptor = fresh;
            attempt = await send(descriptor);
          }
        }
      } catch (error) {
        const stop = stopped();
        if (stop) return refuse(stop);
        logger.warn(`[gateway] ${id}: ${descriptor.provider} image upstream unreachable — ${error instanceof Error ? error.message : String(error)}`);
        failed(model, {
          status: 502,
          code: 'image_upstream_unreachable',
          message: `${descriptor.provider === 'openai-codex' ? 'ChatGPT' : provider} could not be reached.`,
          suggestion: 'Retry the request.',
        });
        break;
      }
      emit.mark('upstream_response');

      if (attempt.ok) {
        const counts = attempt.usage;
        const free = descriptor.billingMode === 'none';
        const { upstreamCost, finalCost } = calculateCost(
          descriptor.resolvedModel ?? model,
          counts,
          free ? 0 : descriptor.markup,
          attempt.upstreamCostUsd,
          descriptor.pricing,
        );
        const upstream = descriptor.publicProvider
          ? { upstream: { provider: descriptor.provider, model: descriptor.resolvedModel ?? model } }
          : {};
        const tokens = counts.promptTokens + counts.completionTokens;
        const body = JSON.stringify({
          created: attempt.created ?? Math.floor(Date.now() / 1000),
          model,
          provider,
          data: [{ b64_json: attempt.b64, mime_type: attempt.mimeType }],
          ...(attempt.size ? { size: attempt.size } : {}),
          ...(tokens > 0
            ? { usage: { input_tokens: counts.promptTokens, output_tokens: counts.completionTokens, total_tokens: tokens } }
            : {}),
        });
        const headers = { 'content-type': 'application/json', ...limitHeaders(attempt.headers) };
        // The response body is now the only copy of the image.
        attempt.b64 = '';
        try {
          await hooks.recordUsage({
            ...counts,
            ...identity(principal),
            provider,
            model: resolvedModel,
            ...upstream,
            upstreamCost,
            finalCost,
            billingMode: descriptor.billingMode,
            streaming: false,
            requestId: id,
            ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
          });
        } catch (error) {
          logger.error(`[gateway] ${id}: image usage was not recorded — ${error instanceof Error ? error.message : String(error)}`);
        }
        trace(
          { status: 200, ok: true },
          {
            ...upstream,
            billingMode: descriptor.billingMode,
            servedModel: model,
            ...(model !== models[0] ? { fallbackFrom: models[0] } : {}),
            usage: counts,
            upstreamCost,
            finalCost,
          },
        );
        return new Response(body, { status: 200, headers });
      }

      // An abort while the answer was read leaves an unreadable 200.
      const stop = stopped();
      if (stop) return refuse(stop);
      // Server log only: the upstream's own text and identity.
      if (attempt.detail) {
        logger.warn(`[gateway] ${id}: ${descriptor.provider} image ${attempt.status} for ${descriptor.resolvedModel ?? model}: ${attempt.detail.slice(0, 300)}`);
      }
      failed(model, refusalFor(attempt, descriptor, model, provider));
      // The image quota is separate from chat, and the pool cooldown is keyed
      // per secret: noting it here would block chat on this login (R6). A 429
      // tries the next pooled account within this request only.
      if (attempt.status === 429) continue;
      break;
    }
  }

  // Every planned model failed: the last failure is the answer.
  return refuse(last!);
}
