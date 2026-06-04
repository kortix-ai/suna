import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../../types';
import { verifySessionLlmToken } from '../../shared/session-llm-token';
import { getProjectSecretValue } from '../../projects/secrets';
import { proxyToOpenRouter, extractUsage, calculateCost, getModel, getAllModels } from '../services/llm';
import { checkCredits, deductLLMCredits } from '../services/billing';
import { recordUsageEvent } from '../../shared/usage-events';
import { enforceRateLimit, sessionLlmLimiter } from '../../shared/rate-limit';
import { resolveAccountTier, sessionLlmPolicyForTier } from '../../shared/account-limits';
import { getTraceHeaders } from '../../lib/request-context';
import { makeOpenApiApp, json, errors, auth } from '../../openapi';

const sessionLlm = makeOpenApiApp<{ Variables: AppContext }>();

/** OpenAI-compatible model object served by /llm/models. */
const SessionModelObjectSchema = z
  .object({
    id: z.string(),
    object: z.string(),
    created: z.number(),
    owned_by: z.string(),
    context_window: z.number().optional(),
    pricing: z.any().optional(),
    tier: z.string().optional(),
  })
  .openapi('SessionLlmModel');

const SessionModelListSchema = z
  .object({ object: z.string(), data: z.array(SessionModelObjectSchema) })
  .openapi('SessionLlmModelList');

function bearerToken(c: any): string | null {
  const header = c.req.header('Authorization') || c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

async function resolveLlmContext(c: any) {
  const verified = verifySessionLlmToken(bearerToken(c));
  if (!verified.ok) {
    throw new HTTPException(401, { message: `Invalid LLM token: ${verified.reason}` });
  }
  return verified.context;
}

async function resolveOpenRouterKey(projectId: string): Promise<string | null> {
  return await getProjectSecretValue(projectId, 'OPENROUTER_API_KEY')
    ?? process.env.OPENROUTER_API_KEY
    ?? null;
}

async function enforceSessionLlmRateLimit(
  c: any,
  ctx: Awaited<ReturnType<typeof resolveLlmContext>>,
  route: string,
) {
  const tier = await resolveAccountTier(ctx.accountId);
  return enforceRateLimit(
    c,
    sessionLlmLimiter,
    ctx.accountId,
    sessionLlmPolicyForTier(tier),
    {
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: `RATE_LIMIT ${c.req.method} ${route}`,
      resourceType: 'llm_router',
      resourceId: ctx.sessionId,
      metadata: {
        project_id: ctx.projectId,
        session_id: ctx.sessionId,
        tier,
      },
    },
  );
}

sessionLlm.openapi(
  createRoute({
    method: 'post',
    path: '/chat/completions',
    tags: ['router'],
    summary: 'Session-scoped OpenAI-compatible chat completions (session-LLM token, SSE streaming)',
    ...auth,
    // NOTE: intentionally NO `request.body` schema — the handler parses the body
    // manually (model/messages validation → `Validation error: …` HTTPException(400)).
    // Attaching a schema would change that contract / consume the proxied body.
    responses: {
      200: {
        description:
          'Chat completion. JSON when non-streaming; a Server-Sent Events stream (text/event-stream) when stream=true.',
        content: {
          'application/json': { schema: z.any() },
          'text/event-stream': { schema: z.string() },
        },
      },
      ...errors(400, 401, 402, 429, 502, 503),
    },
  }),
  async (c) => {
  const ctx = await resolveLlmContext(c);
  const limited = await enforceSessionLlmRateLimit(c, ctx, '/v1/router/llm/chat/completions');
  if (limited) return limited;

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

  const creditCheck = await checkCredits(ctx.accountId);
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, { message: creditCheck.message || 'Insufficient credits' });
  }

  const apiKey = await resolveOpenRouterKey(ctx.projectId);
  if (!apiKey) {
    throw new HTTPException(503, { message: 'OPENROUTER_API_KEY project secret is not configured' });
  }

  const modelId = body.model;
  const modelConfig = getModel(modelId);
  const isStreaming = body.stream === true;
  const response = await proxyToOpenRouter(body, isStreaming, apiKey, getTraceHeaders());

  if (!response.ok) {
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
    });
  }

  if (isStreaming) {
    const upstreamBody = response.body;
    if (!upstreamBody) {
      throw new HTTPException(502, { message: 'No response body from upstream' });
    }

    const [clientStream, usageStream] = upstreamBody.tee();
    extractStreamingUsage(usageStream, {
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      modelId,
      modelConfig,
      upstreamStatus: response.status,
    });

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
    const cost = calculateCost(
      modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
    );
    deductLLMCredits(
      ctx.accountId,
      modelId,
      usage.promptTokens,
      usage.completionTokens,
      cost,
      ctx.sessionId,
    ).catch((err) => console.error('[session-llm] Failed to deduct credits:', err));
    recordUsageEvent({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      provider: 'openrouter',
      model: modelId,
      route: '/v1/router/llm/chat/completions',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: cost,
      streaming: false,
      upstreamStatus: response.status,
    }).catch((err) => console.error('[session-llm] Failed to record usage event:', err));
  }

  return c.json(responseBody);
  },
);

sessionLlm.openapi(
  createRoute({
    method: 'get',
    path: '/models',
    tags: ['router'],
    summary: 'List available models for a session-LLM token (OpenAI-compatible)',
    ...auth,
    responses: {
      200: json(SessionModelListSchema, 'Available models'),
      ...errors(401, 429),
    },
  }),
  async (c) => {
    const ctx = await resolveLlmContext(c);
    const limited = await enforceSessionLlmRateLimit(c, ctx, '/v1/router/llm/models');
    // `limited` is the rate limiter's raw 429 Response (declared via errors(429)).
    // The 200 is a typed JSON response, so cast this early raw-Response return so
    // the handler signature stays json-typed without changing runtime behavior.
    if (limited) return limited as any;
    return c.json({
      object: 'list',
      data: getAllModels().map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.owned_by,
        context_window: m.context_window,
        pricing: m.pricing,
        tier: m.tier,
      })),
    });
  },
);

async function extractStreamingUsage(
  stream: ReadableStream<Uint8Array>,
  input: {
    accountId: string;
    projectId: string;
    sessionId: string;
    actorUserId: string;
    modelId: string;
    modelConfig: ReturnType<typeof getModel>;
    upstreamStatus: number;
  },
) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage: {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      cacheWriteTokens: number;
    } | null = null;

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

    if (!lastUsage) {
      console.warn(`[session-llm] Stream ${input.modelId}: no usage data found`);
      return;
    }

    const cost = calculateCost(
      input.modelConfig,
      lastUsage.promptTokens,
      lastUsage.completionTokens,
      lastUsage.cachedTokens,
      lastUsage.cacheWriteTokens,
    );
    await deductLLMCredits(
      input.accountId,
      input.modelId,
      lastUsage.promptTokens,
      lastUsage.completionTokens,
      cost,
      input.sessionId,
    );
    await recordUsageEvent({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      provider: 'openrouter',
      model: input.modelId,
      route: '/v1/router/llm/chat/completions',
      inputTokens: lastUsage.promptTokens,
      outputTokens: lastUsage.completionTokens,
      cachedTokens: lastUsage.cachedTokens,
      cacheWriteTokens: lastUsage.cacheWriteTokens,
      costUsd: cost,
      streaming: true,
      upstreamStatus: input.upstreamStatus,
    });
  } catch (err) {
    console.error('[session-llm] Failed to extract streaming usage:', err);
  }
}

export { sessionLlm };
