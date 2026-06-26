import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../../types';
import { config } from '../../config';
import { verifySessionLlmToken } from '../../shared/session-llm-token';
import { validateAccountToken } from '../../repositories/account-tokens';
import { getProjectSecretValue } from '../../projects/secrets';
import { proxyToOpenRouter, extractUsage, calculateCost, getModel } from '../services/llm';
import type { ModelConfig } from '../config/models';
import type { UsageInfo } from '../services/llm';
import { resolveManagedRoute, dispatchBedrock, dispatchZen } from '../services/managed-llm';
import { gatewayModelCatalog } from '../../llm-gateway/models/catalog-models';
import { checkCredits, deductLLMCredits } from '../services/billing';
import { recordUsageEvent } from '../../shared/usage-events';
import { enforceRateLimit, sessionLlmLimiter } from '../../shared/rate-limit';
import { resolveAccountTier, sessionLlmPolicyForTier } from '../../shared/account-limits';
import { getTraceHeaders, getRequestContext } from '../../lib/request-context';
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

interface ResolvedLlmContext {
  accountId: string;
  projectId: string;
  sessionId: string;
  userId: string;
}

/**
 * Authenticate a slim-endpoint call. Two credential shapes are accepted, tried
 * cheapest-first:
 *   1. A session-LLM HMAC token (`encodeSessionLlmToken`) — stateless, no DB hit.
 *   2. The per-session EXECUTOR PAT (`kortix_pat_…`) — the credential already
 *      minted by `mintExecutorToken` and injected into the sandbox as
 *      `KORTIX_LLM_API_KEY`, so opencode's `kortix` provider authenticates with
 *      the token it already has (no new mint/inject rail, no TTL/refresh — the
 *      project-scoped PAT lives as long as the sandbox). The slim endpoint is
 *      session-scoped, so the PAT must carry both a project and a session;
 *      `validateAccountToken` resolves account/user/project/session for metering.
 */
async function resolveLlmContext(c: any): Promise<ResolvedLlmContext> {
  const token = bearerToken(c);
  const verified = verifySessionLlmToken(token);
  if (verified.ok) {
    const { accountId, projectId, sessionId, userId } = verified.context;
    return { accountId, projectId, sessionId, userId };
  }

  if (token) {
    const pat = await validateAccountToken(token);
    if (pat.isValid && pat.accountId && pat.userId && pat.projectId && pat.sessionId) {
      return {
        accountId: pat.accountId,
        projectId: pat.projectId,
        sessionId: pat.sessionId,
        userId: pat.userId,
      };
    }
  }

  throw new HTTPException(401, { message: `Invalid LLM token: ${verified.reason}` });
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

  // Route by model: managed Claude → Bedrock InvokeModel, free models → OpenCode
  // Zen (no auth, unmetered), every other managed model + any legacy id →
  // OpenRouter. A simple switch — no failover/breaker.
  const route = resolveManagedRoute(body.model, body);
  const provider =
    route.upstream === 'bedrock' ? 'bedrock' : route.upstream === 'zen' ? 'opencode-zen' : 'openrouter';
  const billingModel = route.billingModel;
  // Free Zen turns are never billed (billingMode none); everything else meters.
  const billable = route.upstream !== 'zen';
  // Managed turns price from the curated per-1M catalog pricing (managed slugs
  // don't resolve on models.dev → a live lookup would silently bill $0). A legacy
  // non-managed id keeps the existing models.dev pricing path.
  const modelConfig: ModelConfig = route.managed
    ? {
        openrouterId: route.managed.upstreamModelId,
        inputPer1M: route.managed.pricing.input,
        outputPer1M: route.managed.pricing.output,
        cacheReadPer1M: route.managed.pricing.cacheRead,
        contextWindow: route.managed.limit.context,
        tier: route.managed.free ? 'free' : 'paid',
      }
    : getModel(billingModel);
  const isStreaming = body.stream === true;
  const traceHeaders = getTraceHeaders();
  const requestId = getRequestContext()?.requestId ?? null;

  let response: Response;
  if (route.upstream === 'bedrock') {
    response = await dispatchBedrock(body, isStreaming, route.wireModel, traceHeaders);
  } else if (route.upstream === 'zen') {
    response = await dispatchZen(body, route.wireModel, traceHeaders);
  } else {
    // Managed models always run on Kortix's OpenRouter key (credits-billed);
    // a legacy/non-managed id keeps using the project's own OPENROUTER_API_KEY.
    const apiKey = route.managed
      ? config.OPENROUTER_API_KEY
      : await resolveOpenRouterKey(ctx.projectId);
    if (!apiKey) {
      throw new HTTPException(503, { message: 'OPENROUTER_API_KEY is not configured' });
    }
    response = await proxyToOpenRouter(
      body,
      isStreaming,
      apiKey,
      traceHeaders,
      route.managed ? route.wireModel : undefined,
    );
  }

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

    // Free Zen turns aren't metered — stream straight through (no tee/usage parse).
    if (!billable) {
      return new Response(upstreamBody, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const [clientStream, usageStream] = upstreamBody.tee();
    extractStreamingUsage(usageStream, {
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      actorUserId: ctx.userId,
      provider,
      modelId: billingModel,
      modelConfig,
      upstreamStatus: response.status,
      requestId,
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
  if (billable) {
    const usage = extractUsage(responseBody);
    if (usage) {
      void meterManagedUsage({
        accountId: ctx.accountId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        actorUserId: ctx.userId,
        provider,
        modelId: billingModel,
        modelConfig,
        usage,
        streaming: false,
        upstreamStatus: response.status,
        requestId,
      }).catch((err) => console.error('[session-llm] Failed to meter usage:', err));
    }
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
    // The managed catalog (Bedrock Claude + OpenRouter rest, managed-only) served
    // as an OpenAI model list — this is what opencode's `kortix` provider lists.
    const created = Math.floor(Date.now() / 1000);
    return c.json({
      object: 'list',
      data: Object.entries(gatewayModelCatalog(undefined)).map(([id, m]) => ({
        id,
        object: 'model',
        created,
        owned_by: 'kortix',
        context_window: m.limit?.context,
      })),
    });
  },
);

interface MeterManagedUsageInput {
  accountId: string;
  projectId: string;
  sessionId: string;
  actorUserId: string;
  provider: string;
  modelId: string;
  modelConfig: ModelConfig;
  usage: UsageInfo;
  streaming: boolean;
  upstreamStatus: number;
  requestId: string | null;
}

/**
 * Meter one billable managed turn: record the usage event (idempotent on
 * request_id), THEN debit credits ONLY when THIS call inserted the row. A replay
 * (reconciler backfill or a retry of the same request_id) finds the existing row
 * (inserted:false) and skips the duplicate debit. A NULL request_id always
 * inserts → always debits (legacy behavior). Cost is from the curated managed
 * pricing carried in `modelConfig`.
 */
async function meterManagedUsage(input: MeterManagedUsageInput): Promise<void> {
  const cost = calculateCost(
    input.modelConfig,
    input.usage.promptTokens,
    input.usage.completionTokens,
    input.usage.cachedTokens,
    input.usage.cacheWriteTokens,
  );
  const { inserted } = await recordUsageEvent({
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    provider: input.provider,
    model: input.modelId,
    route: '/v1/router/llm/chat/completions',
    inputTokens: input.usage.promptTokens,
    outputTokens: input.usage.completionTokens,
    cachedTokens: input.usage.cachedTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    costUsd: cost,
    streaming: input.streaming,
    upstreamStatus: input.upstreamStatus,
    requestId: input.requestId,
  });
  if (!inserted) return;
  await deductLLMCredits(
    input.accountId,
    input.modelId,
    input.usage.promptTokens,
    input.usage.completionTokens,
    cost,
    input.sessionId,
  );
}

async function extractStreamingUsage(
  stream: ReadableStream<Uint8Array>,
  input: {
    accountId: string;
    projectId: string;
    sessionId: string;
    actorUserId: string;
    provider: string;
    modelId: string;
    modelConfig: ModelConfig;
    upstreamStatus: number;
    requestId: string | null;
  },
) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage: UsageInfo | null = null;

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

    await meterManagedUsage({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      provider: input.provider,
      modelId: input.modelId,
      modelConfig: input.modelConfig,
      usage: lastUsage,
      streaming: true,
      upstreamStatus: input.upstreamStatus,
      requestId: input.requestId,
    });
  } catch (err) {
    console.error('[session-llm] Failed to extract streaming usage:', err);
  }
}

export { sessionLlm };
