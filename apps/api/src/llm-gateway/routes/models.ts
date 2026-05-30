import { Hono } from 'hono';
import type { LlmGatewayConfig } from '../types';
import { listOpenRouterModels } from '../services/openrouter-client';

export function createModelsRoute(config: LlmGatewayConfig): Hono {
  const app = new Hono();

  app.get('/models', async (c) => {
    const baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    const upstream = await listOpenRouterModels({
      baseUrl,
      apiKey: config.openrouterApiKey,
      appName: config.appName,
      appReferer: config.appReferer,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return c.json(
        { error: text || `OpenRouter models endpoint error ${upstream.status}` },
        upstream.status as any,
      );
    }

    const json = await upstream.json();
    return c.json(json);
  });

  return app;
}
