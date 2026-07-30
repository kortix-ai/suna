import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../../types';
import {
  accumulateUsageChunk,
  proxyToOpenRouter,
  extractUsage,
  calculateCost,
  getModel,
  getAllModels,
  type UsageAccumulator,
} from '../services/llm';
import { getSandboxMemberCapStatus } from '../services/member-spend';
import { resolveActorFromRequest, type ActorContext } from '../../shared/actor-context';
import { getTraceHeaders } from '../../lib/request-context';
import { makeOpenApiApp, json, errors, auth } from '../../openapi';
import {
  refundLlmReservation,
  reserveEstimatedLlmCredits,
  settleLlmReservation,
  type LlmCreditReservation,
} from '../services/llm-reservation';
import { KORTIX_MARKUP } from '../../config';

const llm = makeOpenApiApp<{ Variables: AppContext }>();

/** OpenAI-compatible model object, as serialized by /models[/{model}]. */
const ModelObjectSchema = z
  .object({
    id: z.string(),
    object: z.string(),
    created: z.number(),
    owned_by: z.string(),
    context_window: z.number().optional(),
    pricing: z.any().optional(),
    tier: z.string().optional(),
  })
  .openapi('LlmModel');

const ModelListSchema = z
  .object({ object: z.string(), data: z.array(ModelObjectSchema) })
  .openapi('LlmModelList');

llm.openapi(
  createRoute({
    method: 'post',
    path: '/chat/completions',
    tags: ['router'],
    summary: 'OpenAI-compatible chat completions (proxied to OpenRouter, supports SSE streaming)',
    ...auth,
    // NOTE: intentionally NO `request.body` schema — the handler parses the body
    // manually (validating model/messages and emitting `Validation error: …`
    // HTTPException(400)). Attaching a schema would let the zod-openapi validator
    // run first and change that contract / consume the proxied body.
    responses: {
      200: {
        description:
          'Chat completion. JSON when non-streaming; a Server-Sent Events stream (text/event-stream) when stream=true.',
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
      throw new HTTPException(400, {
        message: 'Validation error: messages is required and must be a non-empty array',
      });
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

    const reservation = await reserveEstimatedLlmCredits(
      accountId,
      JSON.stringify(body),
      KORTIX_MARKUP,
      actor,
      'openrouter',
    );
    const modelConfig = reservation?.modelConfig ?? getModel(modelId, 'openrouter');
    if (!modelConfig) {
      throw new HTTPException(422, {
        message: `No billing price for openrouter/${modelId}. The request was not sent upstream.`,
      });
    }
    let response: Response;
    try {
      response = await proxyToOpenRouter(body, isStreaming, undefined, getTraceHeaders());
    } catch (error) {
      await refundLlmReservation(
        reservation,
        `LLM router reservation refund after dispatch error: ${modelId}`,
      );
      throw error;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[LLM] OpenRouter error ${response.status}: ${errorBody}`);
      await refundLlmReservation(
        reservation,
        `LLM router reservation refund after upstream error: ${modelId}`,
      );
      return new Response(errorBody, {
        status: response.status,
        headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
      });
    }

    if (isStreaming) {
      const upstreamBody = response.body;
      if (!upstreamBody) {
        await refundLlmReservation(
          reservation,
          `LLM router reservation refund after missing stream body: ${modelId}`,
        );
        throw new HTTPException(502, { message: 'No response body from upstream' });
      }

      const [clientStream, billingStream] = upstreamBody.tee();

      extractUsageFromStream(
        billingStream,
        modelConfig,
        modelId,
        accountId,
        sessionId,
        actor,
        reservation,
      );

      return new Response(clientStream, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    let responseBody: any;
    try {
      responseBody = await response.json();
    } catch {
      await refundLlmReservation(
        reservation,
        `LLM router reservation refund after invalid JSON response: ${modelId}`,
      );
      throw new HTTPException(502, { message: 'OpenRouter returned an invalid JSON response' });
    }

    const usage = extractUsage(responseBody);
    if (usage) {
      const cost = calculateCost(
        modelConfig,
        usage.promptTokens,
        usage.completionTokens,
        usage.cachedTokens,
        usage.cacheWriteTokens,
        KORTIX_MARKUP,
        usage.upstreamCost,
      );
      await settleLlmReservation({
        accountId,
        modelId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        actualCost: cost,
        reservation,
        actor,
        logPrefix: 'LLM router billing',
        provider: 'openrouter',
        route: '/v1/router/chat/completions',
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        upstreamCost: usage.upstreamCost,
        upstreamStatus: response.status,
        sessionId,
      });
      const cacheInfo =
        usage.cachedTokens || usage.cacheWriteTokens
          ? ` (cache: ${usage.cachedTokens}read/${usage.cacheWriteTokens}write)`
          : '';
      console.log(
        `[LLM] ${modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens${cacheInfo}, cost=$${cost.toFixed(6)}`,
      );
    } else {
      await refundLlmReservation(
        reservation,
        `LLM router reservation refund after missing usage: ${modelId}`,
      );
    }

    return c.json(responseBody);
  },
);

llm.openapi(
  createRoute({
    method: 'get',
    path: '/models',
    tags: ['router'],
    summary: 'List available LLM models (OpenAI-compatible)',
    ...auth,
    responses: {
      200: json(ModelListSchema, 'Available models'),
      ...errors(401),
    },
  }),
  async (c) => {
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
  },
);

llm.openapi(
  createRoute({
    method: 'get',
    path: '/models/{model}',
    tags: ['router'],
    summary: 'Get a single LLM model by id (OpenAI-compatible)',
    ...auth,
    request: { params: z.object({ model: z.string() }) },
    responses: {
      200: json(ModelObjectSchema, 'The model'),
      ...errors(401, 404),
    },
  }),
  async (c) => {
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
  },
);

async function extractUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  modelConfig: import('../config/models').ModelConfig,
  modelId: string,
  accountId: string,
  sessionId?: string,
  actor?: ActorContext | null,
  reservation?: LlmCreditReservation | null,
) {
  let settlementStarted = false;
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usageState: UsageAccumulator | null = null;

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
          usageState = accumulateUsageChunk(usageState, chunk);
        } catch {}
      }
    }

    if (usageState) {
      const usage = usageState.usage;
      const cost = calculateCost(
        modelConfig,
        usage.promptTokens,
        usage.completionTokens,
        usage.cachedTokens,
        usage.cacheWriteTokens,
        KORTIX_MARKUP,
        usage.upstreamCost,
      );
      settlementStarted = true;
      await settleLlmReservation({
        accountId,
        modelId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        actualCost: cost,
        reservation: reservation ?? null,
        actor: actor ?? null,
        logPrefix: 'LLM router stream billing',
        provider: 'openrouter',
        route: '/v1/router/chat/completions',
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        upstreamCost: usage.upstreamCost,
        streaming: true,
        upstreamStatus: 200,
        sessionId,
      });
      const cacheInfo =
        usage.cachedTokens || usage.cacheWriteTokens
          ? ` (cache: ${usage.cachedTokens}read/${usage.cacheWriteTokens}write)`
          : '';
      console.log(
        `[LLM] Stream ${modelId}: ${usage.promptTokens}/${usage.completionTokens} tokens${cacheInfo}, cost=$${cost.toFixed(6)}`,
      );
    } else {
      console.warn(`[LLM] Stream ${modelId}: no usage data found in stream — billing skipped`);
      await refundLlmReservation(
        reservation ?? null,
        `LLM router reservation refund after missing stream usage: ${modelId}`,
      );
    }
  } catch (err) {
    console.error(`[LLM] Error extracting usage from stream for billing:`, err);
    if (!settlementStarted) {
      await refundLlmReservation(
        reservation ?? null,
        `LLM router reservation refund after stream usage error: ${modelId}`,
      ).catch((refundError) =>
        console.error('[LLM] LLM router reservation refund failed:', refundError),
      );
    }
  }
}

function resolveActor(c: Parameters<typeof resolveActorFromRequest>[0]): ActorContext | null {
  return resolveActorFromRequest(c, { logPrefix: '[LLM]' });
}

export { llm };
