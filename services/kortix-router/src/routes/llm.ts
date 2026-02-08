import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext } from '../types';
import { generate, stream, calculateCost, getAllModels, getModel } from '../services/llm';
import { checkCredits, deductLLMCredits } from '../services/billing';

const llm = new Hono<{ Variables: AppContext }>();

// Request validation schema
const ChatCompletionSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })
  ),
  max_tokens: z.number().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional().default(false),
  session_id: z.string().optional(),
});

/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible chat completions endpoint.
 */
llm.post('/chat/completions', async (c) => {
  const accountId = c.get('accountId');

  // Parse request
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }

  const parseResult = ChatCompletionSchema.safeParse(body);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new HTTPException(400, { message: `Validation error: ${errors}` });
  }

  const request = parseResult.data;

  // Check credits
  const creditCheck = await checkCredits(accountId);
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, { message: creditCheck.message || 'Insufficient credits' });
  }

  // Get model config for tier check
  const modelConfig = getModel(request.model);

  // Handle streaming
  if (request.stream) {
    const result = await stream(request);

    if (!result.success) {
      throw new HTTPException(502, { message: result.error || 'LLM stream failed' });
    }

    // Deduct credits when stream completes (fire and forget)
    result.usagePromise?.then((usage) => {
      const cost = calculateCost(result.modelConfig!, usage.promptTokens, usage.completionTokens);
      deductLLMCredits(
        accountId,
        request.model,
        usage.promptTokens,
        usage.completionTokens,
        cost,
        request.session_id
      );
      console.log(`[LLM] Stream complete: ${usage.promptTokens}/${usage.completionTokens} tokens, cost=$${cost.toFixed(6)}`);
    });

    // Return SSE stream
    return streamSSE(c, async (sseStream) => {
      const id = `chatcmpl-${Date.now()}`;

      for await (const chunk of result.stream!) {
        await sseStream.writeSSE({
          data: JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [
              {
                index: 0,
                delta: { content: chunk },
                finish_reason: null,
              },
            ],
          }),
        });
      }

      // Send final chunk
      await sseStream.writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        }),
      });

      await sseStream.writeSSE({ data: '[DONE]' });
    });
  }

  // Non-streaming
  const result = await generate(request);

  if (!result.success) {
    throw new HTTPException(502, { message: result.error || 'LLM generation failed' });
  }

  // Deduct credits
  if (result.usage) {
    const cost = calculateCost(result.modelConfig!, result.usage.promptTokens, result.usage.completionTokens);
    await deductLLMCredits(
      accountId,
      request.model,
      result.usage.promptTokens,
      result.usage.completionTokens,
      cost,
      request.session_id
    );
  }

  // Return OpenAI-compatible response
  return c.json({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text,
        },
        finish_reason: 'stop',
      },
    ],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        }
      : undefined,
  });
});

/**
 * GET /v1/models
 *
 * List available models with pricing info.
 */
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

/**
 * GET /v1/models/:model
 *
 * Get specific model info.
 */
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

export { llm };
