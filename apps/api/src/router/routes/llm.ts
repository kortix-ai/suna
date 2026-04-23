import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../../types';
import { proxyToOpenRouter, extractUsage, calculateCost, getModel, getAllModels } from '../services/llm';
import { checkCredits, deductLLMCredits } from '../services/billing';
import {
  applyActorSpend,
  dollarsToCents,
  getSandboxMemberCapStatus,
} from '../services/member-spend';
import {
  resolveActorFromRequest,
  type ActorContext,
} from '../../shared/actor-context';

const llm = new Hono<{ Variables: AppContext }>();

llm.post('/chat/completions', async (c) => {
  const accountId = c.get('accountId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }

  if (!body.model || typeof body.model !== 'string') {
    throw new HTTPException(400, { message: 'Validation error: model is required' });
  }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HTTPException(400, { message: 'Validation error: messages is required and must be a non-empty array' });
  }

  const modelId = body.model as string;
  const isStreaming = body.stream === true;
  const sessionId =
    (typeof body.session_id === 'string' ? body.session_id : undefined) ??
    c.req.header('X-Session-ID') ??
    c.get('sandboxId') ??
    c.get('keyId');

  const actor = resolveActor(c);
  if (actor) {
    const status = await getSandboxMemberCapStatus(actor.sandboxId, actor.userId);
    if (status && status.capCents !== null && status.currentCents >= status.capCents) {
      throw new HTTPException(402, {
        message: `Spending cap reached ($${(status.capCents / 100).toFixed(2)} / month). Ask the instance owner to raise or remove the cap.`,
      });
    }
  }

  const creditCheck = await checkCredits(accountId);
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, { message: creditCheck.message || 'Insufficient credits' });
  }

  const modelConfig = getModel(modelId);
  const response = await proxyToOpenRouter(body, isStreaming);

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[LLM] OpenRouter error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
    });
  }

  if (isStreaming) {
    const upstreamBody = response.body;
    if (!upstreamBody) {
      throw new HTTPException(502, { message: 'No response body from upstream' });
    }

    const [clientStream, billingStream] = upstreamBody.tee();

    extractUsageFromStream(billingStream, modelConfig, modelId, accountId, sessionId, actor);

    return new Response(clientStream, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  const responseBody = await response.json();

  const usage = extractUsage(responseBody);
  if (usage) {
    const cost = calculateCost(modelConfig, usage.promptTokens, usage.completionTokens, usage.cachedTokens, usage.cacheWriteTokens);
    deductLLMCredits(
      accountId,
      modelId,
      usage.promptTokens,
      usage.completionTokens,
      cost,
      sessionId,
    )
      .then((res) => {
        if (res.success && actor && cost > 0) {
          applyActorSpend(actor.sandboxId, actor.userId, dollarsToCents(cost)).catch(
            (err) => console.error('[LLM] Actor spend attribution failed:', err),
          );
        }
      })
      .catch((err) => console.error(`[LLM] Failed to deduct credits for ${modelId}:`, err));
    const cacheInfo = usage.cachedTokens || usage.cacheWriteTokens
      ? ` (cache: ${usage.cachedTokens}read/${usage.cacheWriteTokens}write)`
      : '';
    console.log(`[LLM] ${modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens${cacheInfo}, cost=$${cost.toFixed(6)}`);
  }

  return c.json(responseBody);
});

llm.get('/models', async (c) => {
  const models = getAllModels();

  return c.json({
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: m.owned_by,
      context_window: m.context_window,
      pricing: m.pricing,
      tier: m.tier,
    })),
  });
});

llm.get('/models/:model', async (c) => {
  const modelId = c.req.param('model');
  const models = getAllModels();
  const model = models.find((m) => m.id === modelId);

  if (!model) {
    throw new HTTPException(404, { message: `Model ${modelId} not found` });
  }

  return c.json({
    id: model.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: model.owned_by,
    context_window: model.context_window,
    pricing: model.pricing,
    tier: model.tier,
  });
});

async function extractUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  modelConfig: import('../config/models').ModelConfig,
  modelId: string,
  accountId: string,
  sessionId?: string,
  actor?: ActorContext | null,
) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage: { promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          if (chunk.usage) {
            const details = chunk.usage.prompt_tokens_details;
            lastUsage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              cachedTokens: details?.cached_tokens ?? 0,
              cacheWriteTokens: details?.cache_write_tokens ?? 0,
            };
          }
        } catch {
        }
      }
    }

    if (lastUsage) {
      const cost = calculateCost(modelConfig, lastUsage.promptTokens, lastUsage.completionTokens, lastUsage.cachedTokens, lastUsage.cacheWriteTokens);
      const deductRes = await deductLLMCredits(
        accountId,
        modelId,
        lastUsage.promptTokens,
        lastUsage.completionTokens,
        cost,
        sessionId,
      );
      if (deductRes.success && actor && cost > 0) {
        applyActorSpend(actor.sandboxId, actor.userId, dollarsToCents(cost)).catch(
          (err) => console.error('[LLM] Actor spend attribution failed:', err),
        );
      }
      const cacheInfo = lastUsage.cachedTokens || lastUsage.cacheWriteTokens
        ? ` (cache: ${lastUsage.cachedTokens}read/${lastUsage.cacheWriteTokens}write)`
        : '';
      console.log(`[LLM] Stream ${modelId}: ${lastUsage.promptTokens}/${lastUsage.completionTokens} tokens${cacheInfo}, cost=$${cost.toFixed(6)}`);
    } else {
      console.warn(`[LLM] Stream ${modelId}: no usage data found in stream — billing skipped`);
    }
  } catch (err) {
    console.error(`[LLM] Error extracting usage from stream for billing:`, err);
  }
}

function resolveActor(c: Parameters<typeof resolveActorFromRequest>[0]): ActorContext | null {
  return resolveActorFromRequest(c, { logPrefix: '[LLM]' });
}

export { llm };
