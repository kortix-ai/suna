import type { TokenUsage } from './pricing';

export interface ExtractedUsage extends TokenUsage {
  upstreamCostHint?: number;
  model?: string;
}

export interface UpstreamUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  // `cache_write_tokens` is not part of OpenAI's own usage shape — it's the
  // gateway's own convention (emitted by the anthropic/bedrock transport's
  // OpenAI-shaped translation, see transports/anthropic/response.ts) for
  // surfacing Anthropic's `cache_creation_input_tokens` so it can be priced at
  // the cache-write premium instead of silently folded into plain input.
  cache_write_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cost?: number;
}

export interface UpstreamChunkShape {
  model?: string;
  usage?: UpstreamUsageShape;
}

export function normalizeUsageChunk(raw: UpstreamChunkShape | undefined): ExtractedUsage {
  const usage = raw?.usage;
  const cached = usage?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite =
    usage?.cache_write_tokens ?? usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    cachedTokens: cached,
    cacheWriteTokens: cacheWrite,
    upstreamCostHint: usage?.cost,
    model: raw?.model,
  };
}

export function extractUsageFromJson(json: unknown): ExtractedUsage {
  return normalizeUsageChunk(json as UpstreamChunkShape);
}

export function extractUsageFromSseBuffer(buffer: string): ExtractedUsage | null {
  let lastUsage: ExtractedUsage | null = null;
  let lastModel: string | undefined;

  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as UpstreamChunkShape;
      if (chunk?.model) lastModel = chunk.model;
      if (chunk?.usage) lastUsage = normalizeUsageChunk(chunk);
    } catch {
      continue;
    }
  }

  if (lastUsage && !lastUsage.model && lastModel) lastUsage.model = lastModel;
  return lastUsage;
}
