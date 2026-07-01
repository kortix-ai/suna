import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../../types';
import { verifySessionLlmToken } from '../../shared/session-llm-token';
import { getAllModels } from '../services/llm';
import { enforceRateLimit, sessionLlmLimiter } from '../../shared/rate-limit';
import { resolveAccountTier, sessionLlmPolicyForTier } from '../../shared/account-limits';
import { getTraceHeaders } from '../../lib/request-context';
import { makeOpenApiApp, json, errors, auth } from '../../openapi';
import {
  runSessionOpenRouterLlmWorkflow,
  throwLlmWorkflowHttp,
} from '../services/llm-workflow';

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

    try {
      const result = await runSessionOpenRouterLlmWorkflow({
        accountId: ctx.accountId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        actorUserId: ctx.userId,
        traceHeaders: getTraceHeaders(),
        readJson: () => c.req.json(),
      });

      if (result.kind === 'json') {
        return c.json(result.body);
      }
      return result.response;
    } catch (error) {
      throwLlmWorkflowHttp(error);
    }
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

export { sessionLlm };
