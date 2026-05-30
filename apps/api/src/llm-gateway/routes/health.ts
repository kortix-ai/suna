import { Hono } from 'hono';
import type { LlmGatewayConfig } from '../types';

export function createHealthRoute(config: LlmGatewayConfig): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      enabled: config.enabled,
      baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
      markup: config.markup ?? 1,
      keyConfigured: !!config.openrouterApiKey,
    }),
  );

  return app;
}
