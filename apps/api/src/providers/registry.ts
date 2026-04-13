/**
 * Shared Provider Registry — single source of truth for all provider definitions.
 *
 * Replaces the scattered KEY_SCHEMA, SANDBOX_KEYS, LLM_KEYS, and HELP_URLS
 * constants that were previously duplicated across setup/index.ts,
 * local-env-manager.tsx, setup-overlay.tsx, and config.ts.
 */

export type ProviderCategory = 'llm' | 'tool';

export interface ProviderDef {
  /** Unique slug: "anthropic", "tavily", etc. */
  id: string;
  /** Display name: "Anthropic" */
  name: string;
  /** Category grouping */
  category: ProviderCategory;
  /** Environment variable names for API key(s) */
  envKeys: string[];
  /** Optional env var for overriding the upstream URL */
  envUrlKey?: string;
  /** Default upstream base URL */
  defaultUrl?: string;
  /** Link to obtain an API key */
  helpUrl?: string;
  /** Short description for the UI */
  description?: string;

}

export const PROVIDER_REGISTRY: ProviderDef[] = [
  // ─── LLM Providers ─────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'llm',
    envKeys: ['ANTHROPIC_API_KEY'],
    envUrlKey: 'ANTHROPIC_API_URL',
    defaultUrl: 'https://api.anthropic.com/v1',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    description: 'Claude models (Opus, Sonnet, Haiku)',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'llm',
    envKeys: ['OPENAI_API_KEY'],
    envUrlKey: 'OPENAI_API_URL',
    defaultUrl: 'https://api.openai.com/v1',
    helpUrl: 'https://platform.openai.com/api-keys',
    description: 'GPT and o-series models',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'llm',
    envKeys: ['OPENROUTER_API_KEY'],
    envUrlKey: 'OPENROUTER_API_URL',
    defaultUrl: 'https://openrouter.ai/api/v1',
    helpUrl: 'https://openrouter.ai/keys',
    description: 'Access 200+ models via one API key',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    category: 'llm',
    envKeys: ['GEMINI_API_KEY'],
    envUrlKey: 'GEMINI_API_URL',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    helpUrl: 'https://aistudio.google.com/apikey',
    description: 'Gemini models',
  },
  {
    id: 'groq',
    name: 'Groq',
    category: 'llm',
    envKeys: ['GROQ_API_KEY'],
    envUrlKey: 'GROQ_API_URL',
    defaultUrl: 'https://api.groq.com/openai/v1',
    helpUrl: 'https://console.groq.com/keys',
    description: 'Ultra-fast inference',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    category: 'llm',
    envKeys: ['XAI_API_KEY'],
    envUrlKey: 'XAI_API_URL',
    defaultUrl: 'https://api.x.ai/v1',
    helpUrl: 'https://console.x.ai',
    description: 'Grok models',
  },

  // ─── Tool Providers ────────────────────────────────────────
  {
    id: 'crw',
    name: 'CRW',
    category: 'tool',
    envKeys: ['CRW_API_KEY'],
    envUrlKey: 'CRW_API_URL',
    defaultUrl: 'https://fastcrw.com/api',
    helpUrl: 'https://fastcrw.com',
    description: 'Web Search, Image Search, Scraping & Crawling (replaces Tavily, Serper, Firecrawl)',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    category: 'tool',
    envKeys: ['TAVILY_API_KEY'],
    envUrlKey: 'TAVILY_API_URL',
    defaultUrl: 'https://api.tavily.com',
    helpUrl: 'https://tavily.com',
    description: 'Web Search',
  },
  {
    id: 'serper',
    name: 'Serper',
    category: 'tool',
    envKeys: ['SERPER_API_KEY'],
    envUrlKey: 'SERPER_API_URL',
    defaultUrl: 'https://google.serper.dev',
    helpUrl: 'https://serper.dev',
    description: 'Google Search',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'tool',
    envKeys: ['FIRECRAWL_API_KEY'],
    envUrlKey: 'FIRECRAWL_API_URL',
    defaultUrl: 'https://api.firecrawl.dev',
    helpUrl: 'https://firecrawl.dev',
    description: 'Web Scraping',
  },
  {
    id: 'replicate',
    name: 'Replicate',
    category: 'tool',
    envKeys: ['REPLICATE_API_TOKEN'],
    envUrlKey: 'REPLICATE_API_URL',
    defaultUrl: 'https://api.replicate.com',
    helpUrl: 'https://replicate.com/account/api-tokens',
    description: 'Image & Video Generation',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'tool',
    envKeys: ['ELEVENLABS_API_KEY'],
    helpUrl: 'https://elevenlabs.io',
    description: 'Text-to-Speech',
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'tool',
    envKeys: ['CONTEXT7_API_KEY'],
    envUrlKey: 'CONTEXT7_API_URL',
    defaultUrl: 'https://context7.com',
    helpUrl: 'https://context7.com',
    description: 'Documentation Search',
  },

];

// ─── Derived Helpers ──────────────────────────────────────────

/** LLM providers only */
export const LLM_PROVIDERS = PROVIDER_REGISTRY.filter((p) => p.category === 'llm');

/** Tool providers only */
export const TOOL_PROVIDERS = PROVIDER_REGISTRY.filter((p) => p.category === 'tool');

/** All env key names that should be synced to the sandbox */
export const ALL_SANDBOX_ENV_KEYS = new Set(PROVIDER_REGISTRY.flatMap((p) => p.envKeys));

/** All LLM env key names (for the "at least one required" check) */
export const LLM_ENV_KEYS = LLM_PROVIDERS.flatMap((p) => p.envKeys);

/** Lookup: env key name → ProviderDef */
export const PROVIDER_BY_ENV_KEY = new Map(
  PROVIDER_REGISTRY.flatMap((p) => p.envKeys.map((k) => [k, p] as const)),
);

/** Lookup: provider ID → ProviderDef */
export const PROVIDER_BY_ID = new Map(PROVIDER_REGISTRY.map((p) => [p.id, p] as const));

/** Build grouped provider key schema from the registry. */
export function buildProviderKeySchema() {
  const groups: Record<string, {
    title: string;
    description: string;
    required: boolean;
    keys: Array<{ key: string; label: string; helpUrl?: string }>;
  }> = {
    llm: {
      title: 'LLM Providers',
      description: 'At least one is required for the AI agent to function.',
      required: true,
      keys: [],
    },
    tools: {
      title: 'Tool Providers',
      description: 'Optional. Enable web search, scraping, image generation, etc.',
      required: false,
      keys: [],
    },
  };

  for (const p of PROVIDER_REGISTRY) {
    const groupKey = p.category === 'tool' ? 'tools' : 'llm';
    for (const envKey of p.envKeys) {
      groups[groupKey].keys.push({
        key: envKey,
        label: p.name,
        helpUrl: p.helpUrl,
      });
    }
  }

  return groups;
}
