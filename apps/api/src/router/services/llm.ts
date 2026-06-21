import { config, KORTIX_MARKUP } from '../../config';
import { getModel, getAllModels, resolveOpenRouterId, type ModelConfig } from '../config/models';

/**
 * Calculate cost based on token usage and model pricing.
 * When cache metrics are available, uses differential pricing for cached/written tokens.
 *
 * @param markup - Multiplier applied to the raw provider cost.
 *   Defaults to KORTIX_MARKUP (1.2× = 20% markup) when Kortix provides the key.
 *   Pass PLATFORM_FEE_MARKUP (0.1× = 10% platform fee) for user-owned keys.
 */
export function calculateCost(
  modelConfig: ModelConfig,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number = 0,
  cacheWriteTokens: number = 0,
  markup: number = KORTIX_MARKUP,
): number {
  // When we have cache metrics and the model has cache pricing, compute differential cost
  if ((cachedTokens > 0 || cacheWriteTokens > 0) && modelConfig.cacheReadPer1M != null) {
    const regularInputTokens = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
    const regularInputCost = (regularInputTokens / 1_000_000) * modelConfig.inputPer1M;
    const cacheReadCost = (cachedTokens / 1_000_000) * modelConfig.cacheReadPer1M;
    const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (modelConfig.cacheWritePer1M ?? modelConfig.inputPer1M);
    const outputCost = (completionTokens / 1_000_000) * modelConfig.outputPer1M;
    return (regularInputCost + cacheReadCost + cacheWriteCost + outputCost) * markup;
  }

  // Fallback: flat input pricing (no cache breakdown)
  const inputCost = (promptTokens / 1_000_000) * modelConfig.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * modelConfig.outputPer1M;
  return (inputCost + outputCost) * markup;
}

/**
 * Forward a chat completion request to OpenRouter as a 1:1 passthrough proxy.
 * Preserves the full request body (tools, tool_choice, response_format, etc).
 *
 * @returns The raw fetch Response from OpenRouter (may be streaming or not).
 */
export async function proxyToOpenRouter(
  body: Record<string, unknown>,
  isStreaming: boolean,
  apiKey = config.OPENROUTER_API_KEY,
  traceHeaders: Record<string, string> = {},
): Promise<Response> {
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenRouter API key not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const modelId = body.model as string;
  const openrouterId = resolveOpenRouterId(modelId);

  // Rewrite the model field to the actual OpenRouter model ID
  const forwardBody = { ...body, model: openrouterId };

  const url = `${config.OPENROUTER_API_URL}/chat/completions`;

  console.log(`[LLM] Proxying to OpenRouter: ${modelId} → ${openrouterId} (stream=${isStreaming})`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': config.FRONTEND_URL || 'https://kortix.ai',
      'X-Title': 'Kortix',
      ...traceHeaders,
    },
    body: JSON.stringify(forwardBody),
  });

  return response;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

/**
 * Extract usage from a non-streaming OpenAI-compatible response body.
 * Includes cache metrics from prompt_tokens_details when available.
 */
export function extractUsage(responseBody: any): UsageInfo | null {
  if (!responseBody?.usage) return null;
  const details = responseBody.usage.prompt_tokens_details;
  return {
    promptTokens: responseBody.usage.prompt_tokens ?? 0,
    completionTokens: responseBody.usage.completion_tokens ?? 0,
    cachedTokens: details?.cached_tokens ?? 0,
    cacheWriteTokens: details?.cache_write_tokens ?? 0,
  };
}

// Re-export model functions used by router handlers.
export { getModel, getAllModels } from '../config/models';
