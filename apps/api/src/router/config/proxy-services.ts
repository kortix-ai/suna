import { config } from '../../config';

// === Key Injection Methods ===

type KeyInjectionMethod =
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
  /** Real upstream base URL (e.g. "https://api.tavily.com") */
  targetBaseUrl: string;
  /** Kortix-owned API key for this upstream service */
  getKortixApiKey: () => string;
  /** How to inject the Kortix-owned API key into upstream requests */
  keyInjection: KeyInjectionMethod;
  /** Only these routes are allowed when using Kortix's key (prevents cost abuse) */
  allowedRoutes: AllowedRoute[];
  /** Default tool name for billing attribution (can be overridden per-route) */
  billingToolName: string;
}

// === Service Registry ===

export function getProxyServices(): Record<string, ProxyServiceConfig> {
  return {
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
        // Starting a crawl is billed once. A status poll is free upstream, so
        // it is not billed (`proxy_firecrawl_status` has a zero price).
        { path: '/v1/crawl', methods: ['POST'] },
        { path: '/v1/crawl', methods: ['GET'], prefixMatch: true, billingToolName: 'proxy_firecrawl_status' },
        { path: '/v1/map', methods: ['POST'] },
        { path: '/v1/search', methods: ['POST'] },
        // Firecrawl JS SDK v2+ uses /v2 endpoints
        { path: '/v2/scrape', methods: ['POST'] },
        { path: '/v2/crawl', methods: ['POST'] },
        { path: '/v2/crawl', methods: ['GET'], prefixMatch: true, billingToolName: 'proxy_firecrawl_status' },
        { path: '/v2/map', methods: ['POST'] },
        { path: '/v2/search', methods: ['POST'] },
      ],
      billingToolName: 'proxy_firecrawl',
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
