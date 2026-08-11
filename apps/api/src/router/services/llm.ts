import { config, KORTIX_MARKUP } from '../../config';
import { OPENROUTER_APP_REFERER, OPENROUTER_APP_TITLE } from '../../openrouter-attribution';
import { getModel, getAllModels, resolveOpenRouterId, type ModelConfig } from '../config/models';

/**
 * Calculate cost based on token usage and model pricing.
 * When cache metrics are available, uses differential pricing for cached/written tokens.
 *
 * @param markup - Multiplier applied to the raw provider cost.
 *   Defaults to KORTIX_MARKUP (1.2× = 20% markup) when dosco provides the key.
 *   Pass PLATFORM_FEE_MARKUP (0.1× = 10% platform fee) for user-owned keys.
 */
export function calculateCost(
  modelConfig: ModelConfig,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number = 0,
  cacheWriteTokens: number = 0,
  markup: number = KORTIX_MARKUP,
  upstreamCostHint?: number,
): number {
  if (typeof upstreamCostHint === 'number' && upstreamCostHint >= 0) {
    return upstreamCostHint * markup;
  }
  const tierCandidates = [
    ...(modelConfig.tiers ?? []),
    ...(modelConfig.contextOver200k ? [modelConfig.contextOver200k] : []),
  ]
    .filter((tier) => promptTokens > tier.contextThreshold)
    .sort((a, b) => b.contextThreshold - a.contextThreshold);
  const pricing = tierCandidates[0] ?? modelConfig;
  // Cache categories are always priced independently. Missing category rates
  // fall back to the plain input rate.
  if (cachedTokens > 0 || cacheWriteTokens > 0) {
    const regularInputTokens = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
    const regularInputCost = (regularInputTokens / 1_000_000) * pricing.inputPer1M;
    const cacheReadCost =
      (cachedTokens / 1_000_000) * (pricing.cacheReadPer1M ?? pricing.inputPer1M);
    const cacheWriteCost =
      (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePer1M ?? pricing.inputPer1M);
    const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M;
    return (regularInputCost + cacheReadCost + cacheWriteCost + outputCost) * markup;
  }

  // Fallback: flat input pricing (no cache breakdown)
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M;
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
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': OPENROUTER_APP_REFERER,
      'X-Title': OPENROUTER_APP_TITLE,
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
  upstreamCost: number | undefined;
}

/**
 * Extract provider usage into one canonical token shape.
 *
 * Anthropic reports plain input, cache reads, and cache writes separately.
 * `promptTokens` includes all three categories so pricing can subtract the
 * cache categories before it prices the plain-input remainder.
 */
export function extractUsage(
  responseBody: any,
  provider: 'openai' | 'anthropic' = 'openai',
): UsageInfo | null {
  const usage = responseBody?.usage;
  if (!usage) return null;
  if (provider === 'anthropic') {
    const cachedTokens = Number(usage.cache_read_input_tokens ?? 0) || 0;
    const cacheWriteTokens = Number(usage.cache_creation_input_tokens ?? 0) || 0;
    const plainInputTokens = Number(usage.input_tokens ?? 0) || 0;
    return {
      promptTokens: plainInputTokens + cachedTokens + cacheWriteTokens,
      completionTokens: Number(usage.output_tokens ?? 0) || 0,
      cachedTokens,
      cacheWriteTokens,
      upstreamCost: typeof usage.cost === 'number' ? usage.cost : undefined,
    };
  }

  const details = usage.prompt_tokens_details ?? usage.input_tokens_details;
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
    cachedTokens: Number(usage.cached_tokens ?? details?.cached_tokens ?? 0) || 0,
    cacheWriteTokens: Number(usage.cache_write_tokens ?? details?.cache_write_tokens ?? 0) || 0,
    upstreamCost: typeof usage.cost === 'number' ? usage.cost : undefined,
  };
}

export interface UsageAccumulator {
  model?: string;
  usage: UsageInfo;
}

export function accumulateUsageChunk(
  current: UsageAccumulator | null,
  chunk: any,
  provider: 'openai' | 'anthropic' = 'openai',
): UsageAccumulator | null {
  const source =
    provider === 'anthropic' && chunk?.type === 'message_start' ? chunk.message : chunk;
  const next = extractUsage(source, provider);
  const model = source?.model ?? chunk?.model ?? current?.model;
  if (!next) return current ? { ...current, ...(model ? { model } : {}) } : null;
  if (!current) return { ...(model ? { model } : {}), usage: next };
  return {
    ...(model ? { model } : {}),
    usage: {
      promptTokens: next.promptTokens || current.usage.promptTokens,
      completionTokens: next.completionTokens || current.usage.completionTokens,
      cachedTokens: next.cachedTokens || current.usage.cachedTokens,
      cacheWriteTokens: next.cacheWriteTokens || current.usage.cacheWriteTokens,
      upstreamCost: next.upstreamCost ?? current.usage.upstreamCost,
    },
  };
}

// Re-export model functions used by router handlers.
export { getModel, getAllModels } from '../config/models';
