// Maps the gateway's logical model IDs (as exposed under the `kortix` opencode
// provider, e.g. `bedrock/anthropic/claude-opus-4.8`) to AWS Bedrock inference
// profile / model IDs, plus per-model fallback pricing (USD per 1M tokens).
//
// The `bedrock/` prefix is the routing key: any model whose id starts with
// `bedrock/` is served by the Bedrock backend instead of OpenRouter.

export const BEDROCK_PREFIX = 'bedrock/';

export interface BedrockModelEntry {
  /** Bedrock inference profile ID or model ID used in the Converse call. */
  bedrockId: string;
  /** Whether to enable Anthropic extended thinking when the caller asks for reasoning. */
  reasoning?: boolean;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

// Keyed by the logical id WITHOUT the `bedrock/` prefix. Uses cross-region
// inference profiles (the `us.` prefix) which is the supported invocation path
// for these models in us-west-2.
export const BEDROCK_MODELS: Record<string, BedrockModelEntry> = {
  'anthropic/claude-opus-4.8': {
    bedrockId: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
    reasoning: true,
    inputPerMillion: 5,
    outputPerMillion: 25,
    cachedInputPerMillion: 0.5,
  },
  'anthropic/claude-sonnet-4.6': {
    bedrockId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    reasoning: true,
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
  },
  'anthropic/claude-haiku-4.5': {
    bedrockId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    reasoning: true,
    inputPerMillion: 1,
    outputPerMillion: 5,
    cachedInputPerMillion: 0.1,
  },
  'meta/llama-4-maverick': {
    bedrockId: 'us.meta.llama4-maverick-17b-instruct-v1:0',
    inputPerMillion: 0.24,
    outputPerMillion: 0.97,
  },
  'meta/llama-4-scout': {
    bedrockId: 'us.meta.llama4-scout-17b-instruct-v1:0',
    inputPerMillion: 0.17,
    outputPerMillion: 0.66,
  },
  'amazon/nova-pro': {
    bedrockId: 'us.amazon.nova-pro-v1:0',
    inputPerMillion: 0.8,
    outputPerMillion: 3.2,
    cachedInputPerMillion: 0.2,
  },
  'amazon/nova-lite': {
    bedrockId: 'us.amazon.nova-lite-v1:0',
    inputPerMillion: 0.06,
    outputPerMillion: 0.24,
    cachedInputPerMillion: 0.015,
  },
  'deepseek/deepseek-r1': {
    bedrockId: 'us.deepseek.r1-v1:0',
    reasoning: true,
    inputPerMillion: 1.35,
    outputPerMillion: 5.4,
  },
};

/** Strip the routing prefix if present. Returns null if not a Bedrock model. */
export function stripBedrockPrefix(model: string): string | null {
  if (!model.startsWith(BEDROCK_PREFIX)) return null;
  return model.slice(BEDROCK_PREFIX.length);
}

export function isBedrockModel(model: string): boolean {
  return model.startsWith(BEDROCK_PREFIX);
}

export function resolveBedrockModel(model: string): BedrockModelEntry | null {
  const key = stripBedrockPrefix(model);
  if (key == null) return null;
  return BEDROCK_MODELS[key] ?? null;
}
