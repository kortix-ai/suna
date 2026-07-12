import type { GatewayConfig, GatewayHooks } from './domain';
import {
  type ChatCompletionRequest,
  type GatewayDeps,
  type HandlerRuntime,
  handleChatCompletions,
} from './pipeline';
import { CircuitBreaker } from './resilience';
import { gatewayErrorResponse } from './pipeline/error-response';

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
    if (!token) return gatewayErrorResponse(401, {
      message: 'Missing bearer token', code: 'missing_token', provider: '',
      requestedModel: '', resolvedModel: '', requestId,
      suggestion: 'Sign in again or provide a valid API token, then retry.',
    });
    try {
      const principal = await hooks.authenticate(token);
      if (!principal) return gatewayErrorResponse(401, {
        message: 'Invalid token', code: 'invalid_token', provider: '',
        requestedModel: '', resolvedModel: '', requestId,
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
        message: 'Model catalog unavailable', code: 'models_error', provider: '',
        requestedModel: '', resolvedModel: '', requestId,
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

  return {
    chatCompletions: (req: ChatCompletionRequest): Promise<Response> =>
      handleChatCompletions(runtime, req),
    listModels,
    breakerHealth,
  };
}

export interface BreakerHealth {
  provider: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
}
