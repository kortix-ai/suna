import type { GatewayConfig, GatewayHooks } from './domain';
import {
  type AnthropicMessagesRequest,
  anthropicMessagesToChat,
  chatJsonToAnthropicMessage,
  chatSseToAnthropicSse,
} from './ingress/anthropic-messages';
import {
  type ChatCompletionRequest,
  type GatewayDeps,
  type HandlerRuntime,
  handleChatCompletions,
} from './pipeline';
import { gatewayErrorResponse } from './pipeline/error-response';
import { CircuitBreaker } from './resilience';

// Anthropic Messages API error `type` values by HTTP status — used only to
// shape the JSON envelope for clients speaking the Anthropic wire format; the
// underlying gateway error codes/messages (from `gatewayErrorBody`) are
// unchanged and still drive the OpenAI-compat surface.
const ANTHROPIC_ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'invalid_request_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  529: 'overloaded_error',
};

function anthropicErrorType(status: number): string {
  return ANTHROPIC_ERROR_TYPE_BY_STATUS[status] ?? 'api_error';
}

function anthropicErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: anthropicErrorType(status), message } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export function createGateway(
  hooks: GatewayHooks,
  config: GatewayConfig = {},
  deps: GatewayDeps = {},
) {
  const logger = deps.logger ?? console;
  const captureBodies = config.captureBodies ?? true;
  const maxBodyBytes = config.maxCapturedBodyBytes ?? 256 * 1024;
  const breakers = new Map<string, CircuitBreaker>();

  const breakerFor = (provider: string): CircuitBreaker => {
    const existing = breakers.get(provider);
    if (existing) return existing;
    const created = new CircuitBreaker(config.breaker);
    breakers.set(provider, created);
    return created;
  };

  const capture = (value: unknown): unknown => {
    if (!captureBodies) return undefined;
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length > maxBodyBytes) {
        return {
          truncated: true,
          bytes: serialized.length,
          preview: serialized.slice(0, maxBodyBytes),
        };
      }
      return value;
    } catch {
      return undefined;
    }
  };

  const runtime: HandlerRuntime = {
    hooks,
    config,
    logger,
    fetchImpl: deps.fetchImpl,
    captureBodies,
    capture,
    breakerFor,
    maxCapturedBodyBytes: maxBodyBytes,
  };

  const jsonResponse = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  const bearer = (header: string | undefined): string | null => {
    const match = header?.match(/^Bearer\s+(\S.*)$/i);
    return match ? match[1].trim() : null;
  };

  const listModels = async (authorization: string | undefined): Promise<Response> => {
    const requestId = `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const token = bearer(authorization);
    if (!token)
      return gatewayErrorResponse(401, {
        message: 'Missing bearer token',
        code: 'missing_token',
        provider: '',
        requestedModel: '',
        resolvedModel: '',
        requestId,
        suggestion: 'Sign in again or provide a valid API token, then retry.',
      });
    try {
      const principal = await hooks.authenticate(token);
      if (!principal)
        return gatewayErrorResponse(401, {
          message: 'Invalid token',
          code: 'invalid_token',
          provider: '',
          requestedModel: '',
          resolvedModel: '',
          requestId,
          suggestion: 'Sign in again or provide a valid API token, then retry.',
        });
      if (!hooks.listModels) return jsonResponse({ models: {} });
      const models = await hooks.listModels(principal);
      logger.info(
        `[gateway] models ${Object.keys(models).length} for acct=${principal.accountId.slice(0, 8)}`,
      );
      return jsonResponse({ models });
    } catch (err) {
      logger.error('[gateway] model catalog request failed', err);
      return gatewayErrorResponse(502, {
        message: 'Model catalog unavailable',
        code: 'models_error',
        provider: '',
        requestedModel: '',
        resolvedModel: '',
        requestId,
        suggestion: 'Retry the request. If the error continues, reconnect the provider.',
      });
    }
  };

  const breakerHealth = (): BreakerHealth[] =>
    Array.from(breakers.entries()).map(([provider, breaker]) => ({
      provider,
      state: breaker.current,
      failures: breaker.failureCount,
    }));

  // Anthropic Messages API ingress: translate the Anthropic-shaped request
  // into the gateway's internal OpenAI chat.completions representation,
  // drive it through the SAME `handleChatCompletions` pipeline used by the
  // OpenAI-compat surface (so auth/billing/routing/failover/trace are
  // identical), then translate the OpenAI response back to Anthropic shape.
  // Translation happens entirely around the pipeline call — the pipeline
  // itself never sees or produces Anthropic-shaped data.
  const messages = async (req: ChatCompletionRequest): Promise<Response> => {
    let anthropicBody: Record<string, unknown>;
    try {
      anthropicBody = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      return anthropicErrorResponse(400, 'Invalid JSON body');
    }

    const streaming = anthropicBody.stream === true;
    const chatBody = anthropicMessagesToChat(anthropicBody as unknown as AnthropicMessagesRequest);

    const upstream = await handleChatCompletions(runtime, {
      authorization: req.authorization,
      rawBody: JSON.stringify(chatBody),
    });

    if (!upstream.ok) {
      const data = await upstream.json().catch(() => null);
      const message =
        data &&
        typeof data === 'object' &&
        typeof (data as Record<string, unknown>).message === 'string'
          ? ((data as Record<string, unknown>).message as string)
          : 'Upstream request failed';
      return anthropicErrorResponse(upstream.status, message);
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (streaming && contentType.includes('text/event-stream') && upstream.body) {
      const model = typeof chatBody.model === 'string' ? chatBody.model : undefined;
      const anthropicStream = chatSseToAnthropicSse(upstream.body, { model });
      return new Response(anthropicStream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    const data = await upstream.json().catch(() => null);
    if (!data) return anthropicErrorResponse(502, 'Invalid upstream response');
    return jsonResponse(chatJsonToAnthropicMessage(data as Record<string, unknown>));
  };

  return {
    chatCompletions: (req: ChatCompletionRequest): Promise<Response> =>
      handleChatCompletions(runtime, req),
    messages,
    listModels,
    breakerHealth,
  };
}

export interface BreakerHealth {
  provider: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
}
