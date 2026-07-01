import type { Effect } from 'effect';
import { createRoute, z } from '@hono/zod-openapi';
import type { AppContext } from '../../types';
import { resolveActorFromRequest } from '../../shared/actor-context';
import { getTraceHeaders } from '../../lib/request-context';
import { makeOpenApiApp, errors, auth } from '../../openapi';
import {
  runAnthropicLlmWorkflow,
  throwLlmWorkflowHttp,
} from '../services/llm-workflow';

const anthropic = makeOpenApiApp<{ Variables: AppContext }>();


/**
 * POST /messages
 *
 * Anthropic Messages API proxy — forwards to Anthropic's /v1/messages endpoint.
 *
 * Handles:
 * - Model resolution (Kortix model IDs → Anthropic native model IDs)
 * - Credit checking and cache-aware billing
 * - Streaming (SSE) and non-streaming responses
 *
 * Preserves cache_control fields injected by @ai-sdk/anthropic's setCacheKey.
 */
anthropic.openapi(
  createRoute({
    method: 'post',
    path: '/messages',
    tags: ['router'],
    summary: 'Anthropic Messages API proxy (supports SSE streaming)',
    ...auth,
    // NOTE: intentionally NO `request.body` schema — the handler parses the body
    // manually (model/messages validation → `Validation error: …` HTTPException(400)).
    // Attaching a schema would change that contract / consume the proxied body.
    responses: {
      200: {
        description:
          'Anthropic message. JSON when non-streaming; a Server-Sent Events stream (text/event-stream) when stream=true.',
        content: {
          'application/json': { schema: z.any() },
          'text/event-stream': { schema: z.string() },
        },
      },
      ...errors(400, 401, 402, 502),
    },
  }),
  async (c) => {
    const accountId = c.get('accountId');
    const actor = resolveActorFromRequest(c, { logPrefix: '[LLM][Anthropic]' });

    try {
      const result = await runAnthropicLlmWorkflow({
        accountId,
        actor,
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

export { anthropic };
