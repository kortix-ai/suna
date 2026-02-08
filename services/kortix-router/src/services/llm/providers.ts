import { config } from '../../config';
import type { LLMProvider, ProviderConfig, ChatCompletionRequest, TokenUsage } from '../../types/llm';

/**
 * Determine the provider from a model ID.
 *
 * Model ID patterns:
 * - openrouter/anthropic/claude-3-opus → openrouter
 * - anthropic/claude-sonnet-4 → anthropic (direct if key set, else openrouter)
 * - openai/gpt-4o → openai (direct if key set, else openrouter)
 * - gpt-4o → inferred openai → openrouter fallback
 * - claude-3-opus → inferred anthropic → openrouter fallback
 * - x-ai/grok-2 → xai (via openrouter if no key)
 */
export function getProviderFromModel(modelId: string): LLMProvider {
  const lowerModel = modelId.toLowerCase();

  // Explicit prefix routing
  if (lowerModel.startsWith('openrouter/')) return 'openrouter';
  if (lowerModel.startsWith('anthropic/')) return 'anthropic';
  if (lowerModel.startsWith('openai/')) return 'openai';
  if (lowerModel.startsWith('xai/') || lowerModel.startsWith('x-ai/')) return 'xai';
  if (lowerModel.startsWith('groq/')) return 'groq';
  if (lowerModel.startsWith('gemini/') || lowerModel.startsWith('google/')) return 'gemini';
  if (lowerModel.startsWith('bedrock/') || lowerModel.startsWith('aws/')) return 'bedrock';

  // Inferred routing by model name patterns
  if (lowerModel.includes('claude')) return 'anthropic';
  if (lowerModel.includes('gpt') || lowerModel.includes('o1') || lowerModel.includes('o3')) return 'openai';
  if (lowerModel.includes('grok')) return 'xai';
  if (lowerModel.includes('gemini')) return 'gemini';
  if (lowerModel.includes('llama') || lowerModel.includes('mixtral') || lowerModel.includes('groq')) return 'groq';

  // Default to OpenRouter (supports 100+ models)
  return 'openrouter';
}

/**
 * Strip provider prefix from model ID for API calls.
 */
export function normalizeModelId(modelId: string, provider: LLMProvider): string {
  const prefixes = [
    'openrouter/',
    'anthropic/',
    'openai/',
    'xai/',
    'x-ai/',
    'groq/',
    'gemini/',
    'google/',
    'bedrock/',
    'aws/',
  ];

  for (const prefix of prefixes) {
    if (modelId.toLowerCase().startsWith(prefix)) {
      return modelId.slice(prefix.length);
    }
  }

  return modelId;
}

/**
 * Transform OpenAI format to Anthropic Messages API format.
 */
function transformToAnthropic(req: ChatCompletionRequest): any {
  const systemMessages = req.messages.filter((m) => m.role === 'system');
  const otherMessages = req.messages.filter((m) => m.role !== 'system');

  return {
    model: normalizeModelId(req.model, 'anthropic'),
    messages: otherMessages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
    system: systemMessages.length > 0
      ? systemMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      : undefined,
    max_tokens: req.max_tokens || 4096,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
    stop_sequences: req.stop ? (Array.isArray(req.stop) ? req.stop : [req.stop]) : undefined,
  };
}

/**
 * Extract usage from Anthropic response format.
 */
function extractAnthropicUsage(response: any): TokenUsage {
  return {
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
  };
}

/**
 * Extract usage from OpenAI-compatible response format.
 */
function extractOpenAIUsage(response: any): TokenUsage {
  return {
    inputTokens: response.usage?.prompt_tokens || 0,
    outputTokens: response.usage?.completion_tokens || 0,
    totalTokens: response.usage?.total_tokens || 0,
    cost: response.usage?.total_cost, // OpenRouter provides this
  };
}

/**
 * Get provider configuration.
 * Returns null if provider's API key is not configured.
 */
export function getProviderConfig(provider: LLMProvider): ProviderConfig | null {
  const configs: Record<LLMProvider, ProviderConfig | null> = {
    openrouter: config.OPENROUTER_API_KEY
      ? {
          name: 'openrouter',
          apiUrl: config.OPENROUTER_API_URL,
          apiKey: config.OPENROUTER_API_KEY,
          headers: {
            'HTTP-Referer': 'https://kortix.ai',
            'X-Title': 'Kortix',
          },
          extractUsage: extractOpenAIUsage,
        }
      : null,

    anthropic: config.ANTHROPIC_API_KEY
      ? {
          name: 'anthropic',
          apiUrl: config.ANTHROPIC_API_URL,
          apiKey: config.ANTHROPIC_API_KEY,
          headers: {
            'x-api-key': config.ANTHROPIC_API_KEY,
            'anthropic-version': '2024-10-22',
          },
          transformRequest: transformToAnthropic,
          extractUsage: extractAnthropicUsage,
        }
      : null,

    openai: config.OPENAI_API_KEY
      ? {
          name: 'openai',
          apiUrl: config.OPENAI_API_URL,
          apiKey: config.OPENAI_API_KEY,
          extractUsage: extractOpenAIUsage,
        }
      : null,

    xai: config.XAI_API_KEY
      ? {
          name: 'xai',
          apiUrl: config.XAI_API_URL,
          apiKey: config.XAI_API_KEY,
          extractUsage: extractOpenAIUsage,
        }
      : null,

    groq: config.GROQ_API_KEY
      ? {
          name: 'groq',
          apiUrl: config.GROQ_API_URL,
          apiKey: config.GROQ_API_KEY,
          extractUsage: extractOpenAIUsage,
        }
      : null,

    gemini: null, // Gemini requires different API format - route via OpenRouter

    bedrock: null, // Bedrock requires AWS auth - route via OpenRouter
  };

  return configs[provider];
}

/**
 * Check if a provider is configured (has API key).
 */
export function isProviderConfigured(provider: LLMProvider): boolean {
  return getProviderConfig(provider) !== null;
}

/**
 * Get the effective provider to use.
 * Falls back to OpenRouter if direct provider is not configured.
 */
export function getEffectiveProvider(modelId: string): {
  provider: LLMProvider;
  config: ProviderConfig;
  modelId: string;
} | null {
  const requestedProvider = getProviderFromModel(modelId);
  let providerConfig = getProviderConfig(requestedProvider);
  let effectiveModelId = modelId;

  // If direct provider not configured, fall back to OpenRouter
  if (!providerConfig && requestedProvider !== 'openrouter') {
    providerConfig = getProviderConfig('openrouter');

    if (providerConfig) {
      // Prepend provider prefix for OpenRouter routing
      // e.g., "claude-3-opus" -> "anthropic/claude-3-opus"
      const normalizedModel = normalizeModelId(modelId, requestedProvider);
      effectiveModelId = `${requestedProvider}/${normalizedModel}`;

      console.log(
        `[LLM] Provider ${requestedProvider} not configured, falling back to OpenRouter with model: ${effectiveModelId}`
      );
    }
  }

  if (!providerConfig) {
    return null;
  }

  return {
    provider: providerConfig.name,
    config: providerConfig,
    modelId: effectiveModelId,
  };
}
