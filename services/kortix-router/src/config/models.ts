import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { config } from '../config';

// =============================================================================
// Provider Instances
// =============================================================================

// OpenRouter - fallback for any model
const openrouter = createOpenAICompatible({
  name: 'openrouter',
  baseURL: config.OPENROUTER_API_URL,
  apiKey: config.OPENROUTER_API_KEY,
});

// Direct providers (faster, no middleman)
const anthropic = createAnthropic({
  apiKey: config.ANTHROPIC_API_KEY,
});

const openai = createOpenAI({
  apiKey: config.OPENAI_API_KEY,
});

const xai = createXai({
  apiKey: config.XAI_API_KEY,
});

const groq = createOpenAICompatible({
  name: 'groq',
  baseURL: config.GROQ_API_URL,
  apiKey: config.GROQ_API_KEY,
});

// =============================================================================
// Model Registry
// =============================================================================

export interface ModelConfig {
  model: LanguageModel;
  inputPer1M: number;   // Cost per 1M input tokens (USD)
  outputPer1M: number;  // Cost per 1M output tokens (USD)
  contextWindow: number;
  tier: 'free' | 'paid';
}

export const MODELS: Record<string, ModelConfig> = {
  // -------------------------------------------------------------------------
  // Kortix Aliases (simple names for users)
  // -------------------------------------------------------------------------
  'kortix/basic': {
    model: openrouter('minimax/minimax-m2'),
    inputPer1M: 0.30,
    outputPer1M: 1.20,
    contextWindow: 200000,
    tier: 'free',
  },
  'kortix/power': {
    model: openrouter('moonshotai/kimi-k2.5'),
    inputPer1M: 0.60,
    outputPer1M: 3.00,
    contextWindow: 200000,
    tier: 'paid',
  },

  // -------------------------------------------------------------------------
  // Anthropic (direct)
  // -------------------------------------------------------------------------
  'claude-sonnet-4': {
    model: anthropic('claude-sonnet-4-20250514'),
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    contextWindow: 200000,
    tier: 'paid',
  },
  'claude-3-5-sonnet': {
    model: anthropic('claude-3-5-sonnet-20241022'),
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    contextWindow: 200000,
    tier: 'paid',
  },
  'claude-3-haiku': {
    model: anthropic('claude-3-haiku-20240307'),
    inputPer1M: 0.25,
    outputPer1M: 1.25,
    contextWindow: 200000,
    tier: 'free',
  },

  // -------------------------------------------------------------------------
  // OpenAI (direct)
  // -------------------------------------------------------------------------
  'gpt-4o': {
    model: openai('gpt-4o'),
    inputPer1M: 2.5,
    outputPer1M: 10.0,
    contextWindow: 128000,
    tier: 'paid',
  },
  'gpt-4o-mini': {
    model: openai('gpt-4o-mini'),
    inputPer1M: 0.15,
    outputPer1M: 0.60,
    contextWindow: 128000,
    tier: 'free',
  },
  'gpt-4-turbo': {
    model: openai('gpt-4-turbo'),
    inputPer1M: 10.0,
    outputPer1M: 30.0,
    contextWindow: 128000,
    tier: 'paid',
  },
  'o1': {
    model: openai('o1'),
    inputPer1M: 15.0,
    outputPer1M: 60.0,
    contextWindow: 200000,
    tier: 'paid',
  },
  'o1-mini': {
    model: openai('o1-mini'),
    inputPer1M: 1.1,
    outputPer1M: 4.4,
    contextWindow: 128000,
    tier: 'paid',
  },

  // -------------------------------------------------------------------------
  // xAI (direct)
  // -------------------------------------------------------------------------
  'grok-2': {
    model: xai('grok-2'),
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    contextWindow: 131072,
    tier: 'paid',
  },

  // -------------------------------------------------------------------------
  // Groq (direct - fast inference)
  // -------------------------------------------------------------------------
  'llama-3.3-70b': {
    model: groq('llama-3.3-70b-versatile'),
    inputPer1M: 0.59,
    outputPer1M: 0.79,
    contextWindow: 128000,
    tier: 'free',
  },
  'llama-3.1-8b': {
    model: groq('llama-3.1-8b-instant'),
    inputPer1M: 0.05,
    outputPer1M: 0.08,
    contextWindow: 128000,
    tier: 'free',
  },
};

// =============================================================================
// Model Resolution
// =============================================================================

/**
 * Get model config by ID.
 * Falls back to OpenRouter for unknown models.
 */
export function getModel(modelId: string): ModelConfig {
  // Direct lookup
  if (MODELS[modelId]) {
    return MODELS[modelId];
  }

  // OpenRouter passthrough (e.g., "openrouter/meta-llama/llama-3-70b")
  if (modelId.startsWith('openrouter/')) {
    const actualModel = modelId.replace('openrouter/', '');
    return {
      model: openrouter(actualModel),
      inputPer1M: 0, // Use provider-reported cost
      outputPer1M: 0,
      contextWindow: 128000,
      tier: 'paid',
    };
  }

  // Fallback: route unknown models through OpenRouter
  return {
    model: openrouter(modelId),
    inputPer1M: 0,
    outputPer1M: 0,
    contextWindow: 128000,
    tier: 'paid',
  };
}

/**
 * Get all available models for /v1/models endpoint.
 */
export function getAllModels() {
  return Object.entries(MODELS).map(([id, config]) => ({
    id,
    object: 'model' as const,
    owned_by: getProvider(id),
    context_window: config.contextWindow,
    pricing: {
      input: config.inputPer1M,
      output: config.outputPer1M,
    },
    tier: config.tier,
  }));
}

function getProvider(modelId: string): string {
  if (modelId.startsWith('kortix/')) return 'kortix';
  if (modelId.startsWith('claude')) return 'anthropic';
  if (modelId.startsWith('gpt') || modelId.startsWith('o1')) return 'openai';
  if (modelId.startsWith('grok')) return 'xai';
  if (modelId.startsWith('llama')) return 'groq';
  return 'openrouter';
}
