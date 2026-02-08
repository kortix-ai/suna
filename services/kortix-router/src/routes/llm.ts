import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ChatCompletionRequestSchema } from '../types/llm';
import type { AppContext } from '../types';
import { proxyChatCompletion, getAvailableModels } from '../services/llm';
import { checkCredits, deductLLMCredits } from '../services/billing';
import { calculateLLMCost } from '../config';

const llm = new Hono<{ Variables: AppContext }>();

/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible chat completions endpoint.
 * Routes to appropriate provider based on model ID.
 */
llm.post('/chat/completions', async (c) => {
  const accountId = c.get('accountId');

  // Parse and validate request
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }

  const parseResult = ChatCompletionRequestSchema.safeParse(body);

  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new HTTPException(400, { message: `Validation error: ${errors}` });
  }

  const request = parseResult.data;

  // Check credits before operation
  const creditCheck = await checkCredits(accountId);
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, {
      message: creditCheck.message || 'Insufficient credits',
    });
  }

  // Proxy the request to the appropriate provider
  const result = await proxyChatCompletion(request, accountId);

  if (!result.success) {
    throw new HTTPException(502, {
      message: result.error || 'LLM proxy failed',
    });
  }

  const response = result.response!;

  // Handle streaming response
  if (request.stream) {
    // For streaming, we can't easily deduct credits after completion
    // Options:
    // 1. Estimate and pre-deduct (current approach for simplicity)
    // 2. Track usage via stream parsing (implemented in streaming.ts)
    // 3. Use webhooks for post-stream billing

    // For now, let's trust the stream and rely on usage in final chunk
    // The billing will happen via the streaming proxy's onUsage callback

    // Clone the response body for potential usage extraction
    // Note: This is a simplified approach - production would need more robust handling

    return response;
  }

  // Non-streaming: deduct credits based on actual usage
  if (result.usage) {
    const cost = calculateLLMCost(
      result.provider || 'openrouter',
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.cost
    );

    await deductLLMCredits(
      accountId,
      request.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
      cost,
      request.session_id
    );
  }

  return response;
});

/**
 * GET /v1/models
 *
 * List available models.
 * Returns a curated list of popular models from configured providers.
 */
llm.get('/models', async (c) => {
  const models = getAvailableModels();

  return c.json({
    object: 'list',
    data: models,
  });
});

/**
 * GET /v1/models/:model
 *
 * Get a specific model's info.
 */
llm.get('/models/:model', async (c) => {
  const modelId = c.req.param('model');
  const models = getAvailableModels();

  const model = models.find((m) => m.id === modelId);

  if (!model) {
    throw new HTTPException(404, { message: `Model ${modelId} not found` });
  }

  return c.json(model);
});

export { llm };
