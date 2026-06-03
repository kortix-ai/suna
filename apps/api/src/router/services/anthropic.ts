import { config, KORTIX_MARKUP } from '../../config';
import type { ModelConfig } from '../config/models';
import { getTraceHeaders } from '../../lib/request-context';

const ANTHROPIC_VERSION = '2023-06-01';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

// ─── Proxy ───────────────────────────────────────────────────────────────────

/**
 * Forward a request to OpenRouter's /messages endpoint (Anthropic-compatible format).
 * OpenRouter accepts native Anthropic Messages API requests and routes to the
 * appropriate Anthropic model. Uses OPENROUTER_API_KEY — never ANTHROPIC_API_KEY.
 * Returns the raw fetch Response (may be streaming SSE or JSON).
 */
export async function proxyToAnthropic(
  body: Record<string, unknown>,
  traceHeaders: Record<string, string> = getTraceHeaders(),
): Promise<Response> {
  const apiKey = config.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OpenRouter API key is missing. Set OPENROUTER_API_KEY environment variable.');
  }

  const url = `${config.OPENROUTER_API_URL}/messages`;

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'HTTP-Referer': config.FRONTEND_URL || 'https://kortix.ai',
      'X-Title': 'Kortix',
      ...traceHeaders,
    },
    body: JSON.stringify(body),
  });
}

// ─── Usage Extraction ────────────────────────────────────────────────────────

/**
 * Extract token usage from a non-streaming Anthropic response body.
 * Includes prompt caching metrics when present.
 */
export function extractAnthropicUsage(responseBody: any): AnthropicUsage | null {
  if (!responseBody?.usage) return null;
  return {
    inputTokens: responseBody.usage.input_tokens ?? 0,
    outputTokens: responseBody.usage.output_tokens ?? 0,
    cacheCreationInputTokens: responseBody.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: responseBody.usage.cache_read_input_tokens ?? 0,
  };
}

// ─── Cost Calculation ────────────────────────────────────────────────────────

/**
 * Calculate cost for an Anthropic request.
 * Uses cache-aware pricing when cache metrics are present.
 */
export function calculateAnthropicCost(
  modelConfig: ModelConfig,
  usage: AnthropicUsage,
  markup: number = KORTIX_MARKUP,
): number {
  const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = usage;

  if (
    (cacheCreationInputTokens > 0 || cacheReadInputTokens > 0) &&
    modelConfig.cacheReadPer1M != null
  ) {
    const regularInputTokens = Math.max(
      0,
      inputTokens - cacheCreationInputTokens - cacheReadInputTokens,
    );
    const regularInputCost = (regularInputTokens / 1_000_000) * modelConfig.inputPer1M;
    const cacheReadCost = (cacheReadInputTokens / 1_000_000) * modelConfig.cacheReadPer1M;
    const cacheWriteCost =
      (cacheCreationInputTokens / 1_000_000) *
      (modelConfig.cacheWritePer1M ?? modelConfig.inputPer1M);
    const outputCost = (outputTokens / 1_000_000) * modelConfig.outputPer1M;
    return (regularInputCost + cacheReadCost + cacheWriteCost + outputCost) * markup;
  }

  const inputCost = (inputTokens / 1_000_000) * modelConfig.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * modelConfig.outputPer1M;
  return (inputCost + outputCost) * markup;
}
