import { Hono } from 'hono';
import { createChatCompletionsRoute } from './routes/chat-completions';
import { createModelsRoute } from './routes/models';
import { createHealthRoute } from './routes/health';
import type { LlmGatewayConfig, LlmGatewayHooks } from './types';

export type { LlmGatewayConfig, LlmGatewayHooks, UsageEvent, AuthedPrincipal } from './types';

export function createLlmGateway(
  config: LlmGatewayConfig,
  hooks: LlmGatewayHooks,
): Hono {
  const app = new Hono();

  if (!config.enabled) {
    app.all('/*', (c) => c.json({ error: 'LLM gateway is disabled' }, 503));
    return app;
  }

  if (!config.openrouterApiKey) {
    app.all('/*', (c) =>
      c.json({ error: 'LLM gateway misconfigured: openrouterApiKey missing' }, 500),
    );
    return app;
  }

  app.route('/', createHealthRoute(config));
  app.route('/', createModelsRoute(config));
  app.route('/', createChatCompletionsRoute(config, hooks));

  return app;
}
