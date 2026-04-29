import { config } from '../../config';

// === Key Injection Methods ===

export type KeyInjectionMethod =
  | { type: 'json_body_field'; field: string }
  | { type: 'header'; headerName: string; prefix?: string };

// === Allowed Route Definition ===

export interface AllowedRoute {
  /** Path to match. Exact match unless prefixMatch is true. */
  path: string;
  /** Allowed HTTP methods */
  methods: string[];
  /** If true, match path as prefix (e.g. "/v1/predictions" matches "/v1/predictions/abc123") */
  prefixMatch?: boolean;
  /** Override billing tool name for this specific route (for per-model billing) */
  billingToolName?: string;
}

// === Proxy Service Configuration ===

export interface ProxyServiceConfig {
  /** Service name / route prefix (e.g. "tavily") */
  name: string;
  /** Real upstream base URL (e.g. "https://api.tavily.com") — used for passthrough (Mode 2/3) */
  targetBaseUrl: string;
  /** Alternate upstream base URL for Kortix-managed requests (Mode 1). Falls back to targetBaseUrl. */
  kortixTargetBaseUrl?: string;
  /** Kortix-owned API key for this upstream service */
  getKortixApiKey: () => string;
  /** How to inject the API key into upstream requests (passthrough) */
  keyInjection: KeyInjectionMethod;
  /** Alternate key injection for Kortix-managed requests (Mode 1). Falls back to keyInjection. */
  kortixKeyInjection?: KeyInjectionMethod;
  /** Only these routes are allowed when using Kortix's key (prevents cost abuse) */
  allowedRoutes: AllowedRoute[];
  /** Default tool name for billing attribution (can be overridden per-route) */
  billingToolName: string;
  /**
   * Whether this is an LLM provider (affects passthrough billing).
   * LLM passthrough extracts token usage and bills per-token at platform fee.
   * Tool passthrough uses fixed per-call billing.
   */
  isLlm?: boolean;
}

// === Service Registry ===

export function getProxyServices(): Record<string, ProxyServiceConfig> {
  return {
    // ─── CRW (unified: search, scrape, crawl, map — replaces Tavily, Serper, Firecrawl) ─
    crw: {
      name: 'crw',
      targetBaseUrl: config.CRW_API_URL,
      getKortixApiKey: () => config.CRW_API_KEY,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
      allowedRoutes: [
        { path: '/v1/scrape', methods: ['POST'] },
        { path: '/v1/crawl', methods: ['POST', 'GET', 'DELETE'], prefixMatch: true },
        { path: '/v1/map', methods: ['POST'] },
        { path: '/v1/search', methods: ['POST'] },
        { path: '/v2/scrape', methods: ['POST'] },
        { path: '/v2/crawl', methods: ['POST', 'GET', 'DELETE'], prefixMatch: true },
        { path: '/v2/map', methods: ['POST'] },
        { path: '/v2/search', methods: ['POST'] },
      ],
      billingToolName: 'proxy_crw',
    },

    // ─── Legacy providers (kept for backward compat / gradual migration) ────

    tavily: {
      name: 'tavily',
      targetBaseUrl: config.TAVILY_API_URL,
      getKortixApiKey: () => config.TAVILY_API_KEY,
      keyInjection: { type: 'json_body_field', field: 'api_key' },
      allowedRoutes: [
        { path: '/search', methods: ['POST'] },
      ],
      billingToolName: 'proxy_tavily',
    },

    serper: {
      name: 'serper',
      targetBaseUrl: config.SERPER_API_URL,
      getKortixApiKey: () => config.SERPER_API_KEY,
      keyInjection: { type: 'header', headerName: 'X-API-KEY' },
      allowedRoutes: [
        { path: '/search', methods: ['POST'] },
        { path: '/images', methods: ['POST'] },
        { path: '/news', methods: ['POST'] },
        { path: '/videos', methods: ['POST'] },
        { path: '/scholar', methods: ['POST'] },
      ],
      billingToolName: 'proxy_serper',
    },

    firecrawl: {
      name: 'firecrawl',
      targetBaseUrl: config.FIRECRAWL_API_URL,
      getKortixApiKey: () => config.FIRECRAWL_API_KEY,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
      allowedRoutes: [
        { path: '/v1/scrape', methods: ['POST'] },
        { path: '/v1/crawl', methods: ['POST', 'GET'], prefixMatch: true },
        { path: '/v1/map', methods: ['POST'] },
        { path: '/v1/search', methods: ['POST'] },
        { path: '/v2/scrape', methods: ['POST'] },
        { path: '/v2/crawl', methods: ['POST', 'GET'], prefixMatch: true },
        { path: '/v2/map', methods: ['POST'] },
        { path: '/v2/search', methods: ['POST'] },
      ],
      billingToolName: 'proxy_firecrawl',
    },

    replicate: {
      name: 'replicate',
      targetBaseUrl: config.REPLICATE_API_URL,
      getKortixApiKey: () => config.REPLICATE_API_TOKEN,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Token ' },
      allowedRoutes: [
        {
          path: '/v1/models/google/nano-banana/predictions',
          methods: ['POST'],
          billingToolName: 'proxy_replicate_nano_banana',
        },
        {
          path: '/v1/models/openai/gpt-image-1.5/predictions',
          methods: ['POST'],
          billingToolName: 'proxy_replicate_gpt_image',
        },
      ],
      billingToolName: 'proxy_replicate',
    },

    context7: {
      name: 'context7',
      targetBaseUrl: config.CONTEXT7_API_URL,
      getKortixApiKey: () => config.CONTEXT7_API_KEY,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
      allowedRoutes: [
        { path: '/api/v2/libs/search', methods: ['GET', 'POST'] },
        { path: '/api/v2/context', methods: ['GET', 'POST'] },
      ],
      billingToolName: 'proxy_context7',
    },

    // ─── LLM Providers ─────────────────────────────────────────────────────
    //
    // Dual-mode:
    // - Kortix-managed (Mode 1): uses Kortix-owned provider keys.
    //   Anthropic/OpenAI go direct to native providers.
    //   xAI/Gemini/Groq route through OpenRouter.
    // - Passthrough (Mode 2): forwards the user's own API key to the real
    //   upstream provider for platform-fee billing.
    //
    // Mode 1 (Kortix token in auth): inject provider key configured in service
    // Mode 2 (user key + X-Kortix-Token): passthrough to real provider
    //
    // The proxy handler picks targetBaseUrl for Mode 2/3 and
    // kortixTargetBaseUrl for Mode 1 (when present).

    anthropic: {
      name: 'anthropic',
      targetBaseUrl: config.ANTHROPIC_API_URL,   // https://api.anthropic.com/v1
      getKortixApiKey: () => config.ANTHROPIC_API_KEY,
      keyInjection: { type: 'header', headerName: 'x-api-key' },
      allowedRoutes: [
        { path: '/messages', methods: ['POST'] },
      ],
      billingToolName: 'llm_anthropic',
      isLlm: true,
    },

    openai: {
      name: 'openai',
      targetBaseUrl: config.OPENAI_API_URL,      // https://api.openai.com/v1
      getKortixApiKey: () => config.OPENAI_API_KEY,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
      allowedRoutes: [
        { path: '/chat/completions', methods: ['POST'] },
        { path: '/responses', methods: ['POST'] },
      ],
      billingToolName: 'llm_openai',
      isLlm: true,
    },

    xai: {
      name: 'xai',
      targetBaseUrl: config.XAI_API_URL,         // https://api.x.ai/v1
      kortixTargetBaseUrl: config.OPENROUTER_API_URL,
      getKortixApiKey: () => config.OPENROUTER_API_KEY,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
      allowedRoutes: [
        { path: '/chat/completions', methods: ['POST'] },
      ],
      billingToolName: 'llm_xai',
      isLlm: true,
    },

    gemini: {
      name: 'gemini',
      targetBaseUrl: config.GEMINI_API_URL,      // https://generativelanguage.googleapis.com/v1beta
      kortixTargetBaseUrl: config.OPENROUTER_API_URL,
      getKortixApiKey: () => config.OPENROUTER_API_KEY,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
      allowedRoutes: [
        { path: '/chat/completions', methods: ['POST'] },
      ],
      billingToolName: 'llm_gemini',
      isLlm: true,
    },

    groq: {
      name: 'groq',
      targetBaseUrl: config.GROQ_API_URL,        // https://api.groq.com/openai/v1
      kortixTargetBaseUrl: config.OPENROUTER_API_URL,
      getKortixApiKey: () => config.OPENROUTER_API_KEY,
      keyInjection: { type: 'header', headerName: 'Authorization', prefix: 'Bearer ' },
      allowedRoutes: [
        { path: '/chat/completions', methods: ['POST'] },
      ],
      billingToolName: 'llm_groq',
      isLlm: true,
    },
  };
}

// === Route Matching ===

/**
 * Check if a request method+path is allowed. Returns the matching route or null.
 */
export function matchAllowedRoute(
  method: string,
  path: string,
  allowedRoutes: AllowedRoute[]
): AllowedRoute | null {
  const upperMethod = method.toUpperCase();
  const normalizedPath = path.split('?')[0];

  for (const route of allowedRoutes) {
    if (!route.methods.includes(upperMethod)) continue;

    if (route.prefixMatch) {
      // Prefix match: "/v1/predictions" matches "/v1/predictions/abc123"
      if (
        normalizedPath === route.path ||
        normalizedPath.startsWith(route.path + '/')
      ) {
        return route;
      }
    } else {
      // Exact match only
      if (normalizedPath === route.path) {
        return route;
      }
    }
  }

  return null;
}
