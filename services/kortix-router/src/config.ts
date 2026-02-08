export const config = {
  PORT: parseInt(process.env.PORT || '8008', 10),
  ENV_MODE: process.env.ENV_MODE || 'local',

  // Search Provider URLs (agnostic - can be swapped)
  TAVILY_API_URL: process.env.TAVILY_API_URL || 'https://api.tavily.com',
  SERPER_API_URL: process.env.SERPER_API_URL || 'https://google.serper.dev',

  // Search Provider API Keys
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',
  SERPER_API_KEY: process.env.SERPER_API_KEY || '',

  // Web Scraping Provider URLs
  FIRECRAWL_API_URL: process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev',

  // Web Scraping Provider API Keys
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || '',

  // AI/ML Provider URLs
  REPLICATE_API_URL: process.env.REPLICATE_API_URL || 'https://api.replicate.com/v1',

  // AI/ML Provider API Keys
  REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN || '',

  // Context Provider (if applicable)
  CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY || '',

  // LLM Provider URLs (agnostic - can be swapped)
  OPENROUTER_API_URL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  ANTHROPIC_API_URL: process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1',
  OPENAI_API_URL: process.env.OPENAI_API_URL || 'https://api.openai.com/v1',
  XAI_API_URL: process.env.XAI_API_URL || 'https://api.x.ai/v1',
  GEMINI_API_URL: process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta',
  GROQ_API_URL: process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1',

  // LLM Provider API Keys
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  XAI_API_KEY: process.env.XAI_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK || '',

  // Backend API for billing
  BACKEND_API_URL: process.env.BACKEND_API_URL || 'http://localhost:8000',
  BACKEND_API_KEY: process.env.BACKEND_API_KEY || '',

  isLocal(): boolean {
    return this.ENV_MODE === 'local';
  },

  isDevelopment(): boolean {
    return this.ENV_MODE === 'local' || this.ENV_MODE === 'staging';
  },
};

// Pricing configuration (mirrors Python backend/core/kortix/config.py)
export interface ToolPricing {
  baseCost: number;
  perResultCost: number;
  markupMultiplier: number;
}

export const TOOL_PRICING: Record<string, ToolPricing> = {
  web_search_basic: {
    baseCost: 0.005,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  web_search_advanced: {
    baseCost: 0.025,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  image_search: {
    baseCost: 0.001,
    perResultCost: 0,
    markupMultiplier: 2.0,
  },
};

export function getToolCost(toolName: string, resultCount: number = 0): number {
  const pricing = TOOL_PRICING[toolName];
  if (!pricing) {
    return 0.01;
  }

  const base = pricing.baseCost * pricing.markupMultiplier;
  const perResult = pricing.perResultCost * pricing.markupMultiplier * resultCount;
  return base + perResult;
}

// LLM Pricing configuration
export interface LLMPricing {
  inputCostPer1M: number;   // Cost per 1M input tokens
  outputCostPer1M: number;  // Cost per 1M output tokens
  markupMultiplier: number; // 1.2 = 20% markup
}

// Provider-level pricing (OpenRouter passes through cost, others use estimates)
export const LLM_PRICING: Record<string, LLMPricing> = {
  openrouter: {
    inputCostPer1M: 0,       // Uses cost from response
    outputCostPer1M: 0,
    markupMultiplier: 1.2,   // 20% markup on OpenRouter's reported cost
  },
  anthropic: {
    inputCostPer1M: 3.0,     // Claude Sonnet 4 pricing estimate
    outputCostPer1M: 15.0,
    markupMultiplier: 1.2,
  },
  openai: {
    inputCostPer1M: 2.5,     // GPT-4o pricing estimate
    outputCostPer1M: 10.0,
    markupMultiplier: 1.2,
  },
  xai: {
    inputCostPer1M: 2.0,     // Grok pricing estimate
    outputCostPer1M: 10.0,
    markupMultiplier: 1.2,
  },
  groq: {
    inputCostPer1M: 0.05,    // Groq is cheap
    outputCostPer1M: 0.08,
    markupMultiplier: 1.2,
  },
  gemini: {
    inputCostPer1M: 1.25,    // Gemini Pro estimate
    outputCostPer1M: 5.0,
    markupMultiplier: 1.2,
  },
};

/**
 * Calculate LLM cost based on token usage.
 * For OpenRouter, uses the provider-reported cost if available.
 */
export function calculateLLMCost(
  provider: string,
  inputTokens: number,
  outputTokens: number,
  providerReportedCost?: number
): number {
  const pricing = LLM_PRICING[provider] || LLM_PRICING['openrouter'];

  // OpenRouter reports actual cost - use it with markup
  if (provider === 'openrouter' && providerReportedCost !== undefined) {
    return providerReportedCost * pricing.markupMultiplier;
  }

  // Calculate based on token counts
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return (inputCost + outputCost) * pricing.markupMultiplier;
}
