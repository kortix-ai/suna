import type { GatewayConfig, GatewayHooks } from './domain';
import {
  type ChatCompletionRequest,
  type GatewayDeps,
  type HandlerRuntime,
  handleChatCompletions,
} from './pipeline';
import { CircuitBreaker } from './resilience';

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
    // Wire the per-provider in-memory breaker to the optional fleet-wide signal so
    // a shared open verdict (host-aggregated) opens it on every replica.
    const created = new CircuitBreaker(config.breaker, provider, deps.breakerSignal);
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
    const token = bearer(authorization);
    if (!token) return jsonResponse({ error: 'Missing bearer token' }, 401);
    const principal = await hooks.authenticate(token);
    if (!principal) return jsonResponse({ error: 'Invalid token' }, 401);
    if (!hooks.listModels) return jsonResponse({ models: {} });
    try {
      const models = await hooks.listModels(principal);
      logger.info(
        `[gateway] models ${Object.keys(models).length} for acct=${principal.accountId.slice(0, 8)}`,
      );
      return jsonResponse({ models });
    } catch (err) {
      logger.error('[gateway] listModels failed', err);
      return jsonResponse({ error: 'models unavailable', code: 'models_error' }, 502);
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
