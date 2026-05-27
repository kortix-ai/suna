import { Hono } from 'hono';
import type { LlmGatewayConfig, LlmGatewayHooks, UsageEvent } from '../types';
import { callOpenRouter } from '../services/openrouter-client';
import { calculateCost } from '../services/pricing';
import { extractUsageFromJson, extractUsageFromSseBuffer, type ExtractedUsage } from '../services/usage-extractor';

function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function createChatCompletionsRoute(
  config: LlmGatewayConfig,
  hooks: LlmGatewayHooks,
): Hono {
  const app = new Hono();

  app.post('/chat/completions', async (c) => {
    const requestId = newRequestId();
    const token = bearer(c.req.header('authorization'));

    if (!token) return c.json({ error: 'Missing bearer token' }, 401);
    const principal = await hooks.authenticateToken(token);
    if (!principal) return c.json({ error: 'Invalid token' }, 401);
    try {
      await hooks.assertBillingActive(principal.accountId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Billing inactive';
      return c.json(
        {
          error: message,
          message,
          code: 'subscription_required',
        },
        402,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const streaming = body.stream === true;
    const baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';

    const upstream = await callOpenRouter(
      streaming ? { ...body, stream: true, stream_options: { include_usage: true } } : body,
      {
        baseUrl,
        apiKey: config.openrouterApiKey,
        appName: config.appName,
        appReferer: config.appReferer,
      },
    );

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return c.json(
        { error: text || `OpenRouter upstream error ${upstream.status}` },
        upstream.status as any,
      );
    }

    const finalize = async (usage: ExtractedUsage | null, modelHint?: string) => {
      if (!usage || usage.promptTokens + usage.completionTokens === 0) return;

      const model = (usage.model ?? modelHint ?? (body.model as string) ?? 'unknown').toString();
      const { upstreamCost, finalCost } = calculateCost(
        model,
        {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
        },
        config.markup ?? 1,
        usage.upstreamCostHint,
      );

      const event: UsageEvent = {
        accountId: principal.accountId,
        actorUserId: principal.userId,
        provider: 'openrouter',
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        upstreamCost,
        finalCost,
        streaming,
        requestId,
      };
      try {
        await hooks.recordUsage(event);
      } catch (err) {
        console.warn(`[llm-gateway] recordUsage failed for ${requestId}:`, err);
      }
    };

    if (!streaming) {
      const json = await upstream.json();
      const usage = extractUsageFromJson(json);
      void finalize(usage, body.model as string | undefined);
      return c.json(json);
    }

    const passthrough = new TransformStream<Uint8Array, Uint8Array>();
    const writer = passthrough.writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let sseBuffer = '';

    (async () => {
      const reader = upstream.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            sseBuffer += decoder.decode(value, { stream: true });
            await writer.write(value);
          }
        }
      } catch (err) {
        console.warn(`[llm-gateway] stream read error ${requestId}:`, err);
      } finally {
        try {
          await writer.close();
        } catch {
        }
        const usage = extractUsageFromSseBuffer(sseBuffer);
        void finalize(usage, body.model as string | undefined);
      }
    })().catch(() => {});

    void encoder;
    return new Response(passthrough.readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });

  return app;
}
