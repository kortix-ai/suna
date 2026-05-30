import type { TokenUsage } from './pricing';

export interface ExtractedUsage extends TokenUsage {
  upstreamCostHint?: number;
  model?: string;
}

interface OpenRouterUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

interface OpenRouterChunkShape {
  model?: string;
  usage?: OpenRouterUsageShape;
}

function normalize(raw: OpenRouterChunkShape | undefined): ExtractedUsage {
  const u = raw?.usage;
  const cached =
    u?.cached_tokens ??
    u?.prompt_tokens_details?.cached_tokens ??
    0;
  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    cachedTokens: cached,
    upstreamCostHint: u?.cost,
    model: raw?.model,
  };
}

export function extractUsageFromJson(json: unknown): ExtractedUsage {
  return normalize(json as OpenRouterChunkShape);
}

export function extractUsageFromSseBuffer(buffer: string): ExtractedUsage | null {
  const lines = buffer.split('\n');
  let lastUsage: ExtractedUsage | null = null;
  let lastModel: string | undefined;

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as OpenRouterChunkShape;
      if (obj?.model) lastModel = obj.model;
      if (obj?.usage) {
        lastUsage = normalize(obj);
      }
    } catch {
    }
  }

  if (lastUsage && !lastUsage.model && lastModel) {
    lastUsage.model = lastModel;
  }
  return lastUsage;
}
