import type { AuthorizeResult, UpstreamDescriptor } from '../domain';
import { GatewayResolutionError } from '../errors';
import { parseUpstreamErrorBody } from '../http/parse-upstream-error';
import { trimTrailingSlash } from '../transports/ai-sdk/model';
import { gatewayErrorBody } from './error-response';
import { type HandlerRuntime, authorize, bearer, identity, requestId } from './simple-handler';
import { createTraceEmitter } from './trace';

export type ImageOperation = 'generations' | 'edits';

export interface ImageRequest {
  authorization: string | undefined;
  rawBody: string;
  operation: ImageOperation;
  signal?: AbortSignal;
}

/** The only image models the gateway relays. Any other resolved model is refused. */
const IMAGE_MODELS = ['gpt-image-2'];
const DEFAULT_MODEL = 'codex/gpt-image-2';
const MAX_REFERENCE_IMAGES = 5;
const UPSTREAM_TIMEOUT_MS = 300_000;
/** ChatGPT image-limit headers, relayed on success and on 429 so a client can show when the limit resets. */
const LIMIT_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-primary-reset-after-seconds',
  'x-codex-primary-window-minutes',
];

type ImageBody = Record<string, unknown>;

/**
 * The forwarded body is an allowlist: unknown keys never reach ChatGPT, `n` is
 * always 1, and `model` is set from the descriptor later. Returns an error
 * message for an invalid body.
 */
function imageBody(raw: string, operation: ImageOperation): { body: ImageBody; model: string } | string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 'Invalid JSON body';
  }
  if (!parsed || typeof parsed !== 'object') return 'Invalid JSON body';
  if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) return '`prompt` is required.';
  const body: ImageBody = { prompt: parsed.prompt, n: 1 };
  for (const key of ['size', 'quality', 'background']) {
    if (typeof parsed[key] === 'string') body[key] = parsed[key];
  }
  if (operation === 'edits') {
    const images = parsed.images;
    if (!Array.isArray(images) || images.length < 1 || images.length > MAX_REFERENCE_IMAGES) {
      return `\`images\` needs 1 to ${MAX_REFERENCE_IMAGES} reference images.`;
    }
    const urls = images.map((image) => (image as { image_url?: unknown } | null)?.image_url);
    if (!urls.every((url) => typeof url === 'string' && url)) return 'Every image needs an `image_url`.';
    body.images = urls.map((image_url) => ({ image_url }));
  }
  return { body, model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_MODEL };
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

export async function handleImageRequest(runtime: HandlerRuntime, req: ImageRequest): Promise<Response> {
  const { hooks, logger } = runtime;
  const fetchImpl = runtime.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const id = requestId();
  const startedMs = Date.now();
  const emit = createTraceEmitter(hooks, logger, id, new Date().toISOString(), startedMs);
  const operation = `images.${req.operation}`;
  let requestedModel = '';
  let resolvedModel = '';
  let provider = '';
  let attempts = 0;

  const fail = (
    status: number,
    code: string,
    message: string,
    suggestion: string,
    extra: { retryAfter?: number; headers?: Record<string, string> } = {},
  ): Response => {
    const body = gatewayErrorBody({
      message,
      code,
      provider,
      requestedModel,
      resolvedModel,
      requestId: id,
      suggestion,
      responseStatus: status,
    });
    return new Response(
      JSON.stringify(extra.retryAfter !== undefined ? { ...body, retry_after: extra.retryAfter } : body),
      {
        status,
        headers: {
          'content-type': 'application/json',
          ...(extra.retryAfter !== undefined ? { 'retry-after': String(extra.retryAfter) } : {}),
          ...extra.headers,
        },
      },
    );
  };

  const token = bearer(req.authorization);
  if (!token) {
    return fail(401, 'missing_token', 'Missing bearer token', 'Provide a valid gateway key or account token.');
  }

  let admission: AuthorizeResult;
  try {
    admission = await authorize(hooks, token);
  } catch (error) {
    logger.error(`[gateway] ${id}: admission control unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return fail(503, 'admission_unavailable', 'Gateway admission control is unavailable', 'Retry the request.', {
      retryAfter: 5,
    });
  }

  const traced = (
    response: Response,
    fields: { ok: boolean; errorCode?: string; errorMessage?: string },
  ): Response => {
    const { principal } = admission;
    if (principal) {
      emit({
        ...identity(principal),
        requestedModel,
        resolvedModel,
        provider,
        billingMode: 'none',
        status: response.status,
        ok: fields.ok,
        errorCode: fields.errorCode,
        errorMessage: fields.errorMessage,
        attempts,
        // Never the prompt or the image bytes.
        request: null,
        response: null,
        metadata: { operation },
      });
    }
    return response;
  };
  const refuse = (
    status: number,
    code: string,
    message: string,
    suggestion: string,
    extra?: { retryAfter?: number; headers?: Record<string, string> },
  ) => traced(fail(status, code, message, suggestion, extra), { ok: false, errorCode: code, errorMessage: message });

  if (!admission.ok) {
    const message = admission.message ?? 'Request not allowed';
    return refuse(admission.status, admission.errorCode, message, 'Sign in again or check the account, then retry.');
  }
  const { principal } = admission;

  const parsed = imageBody(req.rawBody, req.operation);
  req.rawBody = '';
  if (typeof parsed === 'string') {
    return refuse(400, 'invalid_request', parsed, 'Fix the request body and retry.');
  }
  requestedModel = parsed.model;

  let candidates: UpstreamDescriptor[];
  try {
    candidates = await hooks.resolveUpstream(principal, requestedModel);
  } catch (error) {
    const resolution = error instanceof GatewayResolutionError ? error : null;
    return refuse(
      resolution?.code === 'provider_pool_rate_limited' ? 429 : 400,
      resolution?.code ?? 'model_unavailable',
      resolution?.message ?? `No provider is configured for model "${requestedModel}"`,
      resolution?.suggestion ?? 'Connect ChatGPT in Models, then retry.',
      { retryAfter: resolution?.retryAfterSeconds },
    );
  }

  // v1 serves only a ChatGPT login (D2), and only the allowlisted model (S4).
  const unsupported = candidates.find(
    (candidate) => candidate.provider !== 'openai-codex' || !IMAGE_MODELS.includes(candidate.resolvedModel ?? ''),
  );
  if (!candidates.length || unsupported) {
    const notCodex = !candidates.length || unsupported?.provider !== 'openai-codex';
    resolvedModel = unsupported?.resolvedModel ?? '';
    return refuse(
      400,
      'image_model_unsupported',
      notCodex
        ? 'Image generation needs a connected ChatGPT account.'
        : `Image generation supports ${IMAGE_MODELS.join(', ')} only.`,
      notCodex ? 'Connect ChatGPT in Models, then retry.' : `Request codex/${IMAGE_MODELS[0]}.`,
    );
  }
  provider = candidates[0].provider;
  resolvedModel = candidates[0].resolvedModel ?? '';

  const signal = req.signal
    ? AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
    : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const send = (descriptor: UpstreamDescriptor): Promise<Response> => {
    attempts += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${descriptor.apiKey}`,
      ...descriptor.headers,
      'x-request-id': id,
    };
    return fetchImpl(`${trimTrailingSlash(descriptor.baseUrl)}/images/${req.operation}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...parsed.body, model: descriptor.resolvedModel }),
      signal,
    });
  };

  let refreshed = false;
  let rateLimited = { rest: 60, headers: {} as Record<string, string> };
  emit.mark('dispatch');
  for (let index = 0; index < candidates.length; index += 1) {
    let descriptor = candidates[index];
    let upstream: Response;
    try {
      upstream = await send(descriptor);
      if (upstream.status === 401 && descriptor.refreshableCredential && hooks.refreshCredential && !refreshed) {
        refreshed = true;
        await upstream.body?.cancel();
        const fresh = await hooks.refreshCredential(principal, descriptor);
        if (!fresh) {
          return refuse(
            401,
            'provider_reauth_required',
            'The ChatGPT login expired.',
            'Reconnect ChatGPT in Models, then retry.',
          );
        }
        descriptor = fresh;
        upstream = await send(descriptor);
      }
    } catch (error) {
      if (req.signal?.aborted) return refuse(499, 'client_aborted', 'The client cancelled the request.', 'Retry the request.');
      if (signal.aborted) {
        return refuse(504, 'image_timeout', 'Image generation timed out.', 'Retry the request.');
      }
      logger.warn(`[gateway] ${id}: image upstream unreachable — ${error instanceof Error ? error.message : String(error)}`);
      return refuse(502, 'image_upstream_unreachable', 'ChatGPT could not be reached.', 'Retry the request.');
    }
    emit.mark('upstream_response');

    if (upstream.ok) {
      // A success body is up to ~4 MB of base64 JSON: stream it through unread.
      return traced(
        new Response(upstream.body, {
          status: upstream.status,
          headers: {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
            ...limitHeaders(upstream.headers),
          },
        }),
        { ok: true },
      );
    }

    if (upstream.status === 429) {
      await upstream.body?.cancel();
      // The image quota is separate from chat, and the pool cooldown is keyed
      // per secret: noting it here would block chat on this login (R6). Try
      // the next pooled account within this request only.
      rateLimited = { rest: restSeconds(upstream.headers), headers: limitHeaders(upstream.headers) };
      continue;
    }

    if (upstream.status === 401) {
      await upstream.body?.cancel();
      return refuse(401, 'provider_reauth_required', 'The ChatGPT login expired.', 'Reconnect ChatGPT in Models, then retry.');
    }

    const { message, code } = parseUpstreamErrorBody(await upstream.text().catch(() => ''));
    const refusal = upstream.status < 500 && SAFETY_REFUSAL.test(`${code ?? ''} ${message}`);
    return refuse(
      upstream.status >= 500 ? 502 : upstream.status,
      'image_upstream_error',
      message || `ChatGPT answered ${upstream.status}.`,
      refusal
        ? 'Change the prompt or the reference images, then retry.'
        : 'Retry, or check the ChatGPT connection in project settings.',
    );
  }

  return refuse(
    429,
    'image_rate_limited',
    'The ChatGPT image limit is reached.',
    'Wait for the limit to reset, then retry.',
    { retryAfter: rateLimited.rest, headers: rateLimited.headers },
  );
}
