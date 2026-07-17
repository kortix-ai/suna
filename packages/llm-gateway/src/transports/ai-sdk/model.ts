import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { UpstreamDescriptor } from '../../domain';

// Which AI SDK provider package a descriptor maps to. Prefer the models.dev
// `npm` field (verbatim from the live catalog, #4893); fall back to the transport
// `kind` so a descriptor that predates npm threading still resolves correctly.
export type AiSdkFamily = 'openai' | 'openai-compatible' | 'anthropic' | 'bedrock';

const OPENAI_NPM = '@ai-sdk/openai';
const ANTHROPIC_NPM = '@ai-sdk/anthropic';
const BEDROCK_NPM = '@ai-sdk/amazon-bedrock';

export function aiSdkFamilyFor(descriptor: UpstreamDescriptor): AiSdkFamily {
  const npm = descriptor.npm;
  if (npm === OPENAI_NPM) return 'openai';
  if (npm === ANTHROPIC_NPM) return 'anthropic';
  if (npm === BEDROCK_NPM) return 'bedrock';
  // Fall back to the transport kind. `openai-compat`/`custom` → the generic
  // OpenAI-compatible provider (the safe default for any /v1/chat/completions
  // upstream, e.g. OpenRouter). anthropic/bedrock map to their native packages.
  switch (descriptor.kind) {
    case 'anthropic':
      return 'anthropic';
    case 'bedrock':
      return 'bedrock';
    default:
      return 'openai-compatible';
  }
}

// AI-SDK-native model families the engine can serve. `openai-responses` (Codex)
// is intentionally excluded — it keeps the native transport regardless of engine.
export function isAiSdkServable(descriptor: UpstreamDescriptor): boolean {
  return descriptor.kind !== 'openai-responses';
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// Build the AI SDK language model for this descriptor. The provider package owns
// every provider-specific wire quirk (endpoint shape, param names, tool schema
// translation, prompt caching, SSE decoding) — we only supply credentials, base
// URL, and the resolved model id.
export function resolveAiModel(descriptor: UpstreamDescriptor): LanguageModel {
  const modelId = descriptor.resolvedModel || '';
  const baseURL = descriptor.baseUrl ? trimTrailingSlash(descriptor.baseUrl) : undefined;
  const headers = descriptor.headers;
  const family = aiSdkFamilyFor(descriptor);

  switch (family) {
    case 'openai': {
      const provider = createOpenAI({ baseURL, apiKey: descriptor.apiKey, headers });
      // Use the Responses API, not chat.completions. OpenAI's reasoning models
      // (gpt-5.x, o-series) reject function tools alongside reasoning_effort on
      // /v1/chat/completions — the SDK injects reasoning_effort for them, so a
      // real gpt-5.6 tool-call turn 400s there. /v1/responses supports reasoning
      // + tools together, and the adapter output is identical either way.
      return provider.responses(modelId);
    }
    case 'anthropic': {
      const provider = createAnthropic({ baseURL, apiKey: descriptor.apiKey, headers });
      return provider(modelId);
    }
    case 'bedrock': {
      // Essentia + the enterprise appliance authenticate with a long-lived bearer
      // token (apiKey), not SigV4 — it takes precedence over AWS credentials in the
      // provider. Region is required by the SDK for the endpoint host.
      const provider = createAmazonBedrock({
        baseURL,
        apiKey: descriptor.apiKey,
        region: descriptor.region || process.env.AWS_REGION || 'us-east-1',
        headers,
      });
      return provider(modelId);
    }
    default: {
      const provider = createOpenAICompatible({
        name: descriptor.provider || 'openai-compatible',
        baseURL: baseURL || '',
        apiKey: descriptor.apiKey,
        headers,
      });
      return provider.chatModel(modelId);
    }
  }
}
