import type { TokenUsage } from './pricing';

export interface ExtractedUsage extends TokenUsage {
  upstreamCostHint?: number;
  model?: string;
}

interface UpstreamUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

interface UpstreamChunkShape {
  model?: string;
  usage?: UpstreamUsageShape;
}

function normalize(raw: UpstreamChunkShape | undefined): ExtractedUsage {
  const usage = raw?.usage;
  const cached = usage?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    cachedTokens: cached,
    upstreamCostHint: usage?.cost,
    model: raw?.model,
  };
}

export function extractUsageFromJson(json: unknown): ExtractedUsage {
  return normalize(json as UpstreamChunkShape);
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
      if (chunk?.usage) lastUsage = normalize(chunk);
    } catch {
      continue;
    }
  }

  if (lastUsage && !lastUsage.model && lastModel) lastUsage.model = lastModel;
  return lastUsage;
}
