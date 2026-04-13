/**
 * Unit tests for matchAllowedRoute() — the route-matching function used by
 * the proxy handler to gate Kortix-user requests to allowed upstream paths.
 *
 * Route data is imported from the real getProxyServices() registry to avoid
 * test data drifting from production config.
 */
import { describe, test, expect } from 'bun:test';
import { matchAllowedRoute, getProxyServices, type AllowedRoute } from '../router/config/proxy-services';

// ─── Test data (from real registry — not duplicated) ─────────────────────────

const services = getProxyServices();
const tavilyRoutes = services.tavily.allowedRoutes;
const serperRoutes = services.serper.allowedRoutes;
const firecrawlRoutes = services.firecrawl.allowedRoutes;
const replicateRoutes = services.replicate.allowedRoutes;
const context7Routes = services.context7.allowedRoutes;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('matchAllowedRoute', () => {
  describe('exact match', () => {
    test('matches exact path and method', () => {
      const result = matchAllowedRoute('POST', '/search', tavilyRoutes);
      expect(result).not.toBeNull();
      expect(result!.path).toBe('/search');
    });

    test('returns null for wrong method', () => {
      const result = matchAllowedRoute('GET', '/search', tavilyRoutes);
      expect(result).toBeNull();
    });

    test('returns null for non-existent path', () => {
      const result = matchAllowedRoute('POST', '/extract', tavilyRoutes);
      expect(result).toBeNull();
    });

    test('returns null for partial path match (no prefix flag)', () => {
      const result = matchAllowedRoute('POST', '/search/extra', tavilyRoutes);
      expect(result).toBeNull();
    });

    test('case-insensitive method matching', () => {
      const result = matchAllowedRoute('post', '/search', tavilyRoutes);
      expect(result).not.toBeNull();
    });

    test('mixed-case method matching', () => {
      const result = matchAllowedRoute('Post', '/search', tavilyRoutes);
      expect(result).not.toBeNull();
    });
  });

  describe('prefix match', () => {
    test('matches exact path with prefixMatch', () => {
      const result = matchAllowedRoute('POST', '/v1/crawl', firecrawlRoutes);
      expect(result).not.toBeNull();
      expect(result!.path).toBe('/v1/crawl');
    });

    test('matches sub-path with prefixMatch', () => {
      const result = matchAllowedRoute('GET', '/v1/crawl/abc123', firecrawlRoutes);
      expect(result).not.toBeNull();
      expect(result!.path).toBe('/v1/crawl');
    });

    test('matches deeper sub-path with prefixMatch', () => {
      const result = matchAllowedRoute('GET', '/v1/crawl/abc123/status', firecrawlRoutes);
      expect(result).not.toBeNull();
    });

    test('does NOT match similar prefix without trailing slash', () => {
      // "/v1/crawl-something" should NOT match "/v1/crawl" prefix
      const result = matchAllowedRoute('POST', '/v1/crawl-something', firecrawlRoutes);
      expect(result).toBeNull();
    });

    test('non-prefixMatch route rejects sub-paths', () => {
      const result = matchAllowedRoute('POST', '/v1/scrape/extra', firecrawlRoutes);
      expect(result).toBeNull();
    });
  });

  describe('query string handling', () => {
    test('strips query string before matching', () => {
      const result = matchAllowedRoute('POST', '/search?q=hello', tavilyRoutes);
      expect(result).not.toBeNull();
    });

    test('strips query string on prefix match', () => {
      const result = matchAllowedRoute('GET', '/v1/crawl/abc123?include_html=true', firecrawlRoutes);
      expect(result).not.toBeNull();
    });
  });

  describe('serper routes', () => {
    test('matches all five serper endpoints', () => {
      for (const path of ['/search', '/images', '/news', '/videos', '/scholar']) {
        const result = matchAllowedRoute('POST', path, serperRoutes);
        expect(result).not.toBeNull();
        expect(result!.path).toBe(path);
      }
    });

    test('rejects GET on all serper endpoints', () => {
      for (const path of ['/search', '/images', '/news', '/videos', '/scholar']) {
        expect(matchAllowedRoute('GET', path, serperRoutes)).toBeNull();
      }
    });
  });

  describe('replicate routes (per-model billing)', () => {
    test('matches nano-banana model route', () => {
      const result = matchAllowedRoute(
        'POST',
        '/v1/models/google/nano-banana/predictions',
        replicateRoutes,
      );
      expect(result).not.toBeNull();
      expect(result!.billingToolName).toBe('proxy_replicate_nano_banana');
    });

    test('matches gpt-image model route', () => {
      const result = matchAllowedRoute(
        'POST',
        '/v1/models/openai/gpt-image-1.5/predictions',
        replicateRoutes,
      );
      expect(result).not.toBeNull();
      expect(result!.billingToolName).toBe('proxy_replicate_gpt_image');
    });

    test('rejects unlisted model', () => {
      const result = matchAllowedRoute(
        'POST',
        '/v1/models/stability-ai/sdxl/predictions',
        replicateRoutes,
      );
      expect(result).toBeNull();
    });

    test('rejects GET on replicate model routes', () => {
      const result = matchAllowedRoute(
        'GET',
        '/v1/models/google/nano-banana/predictions',
        replicateRoutes,
      );
      expect(result).toBeNull();
    });
  });

  describe('context7 routes', () => {
    test('matches GET and POST on libs/search', () => {
      expect(matchAllowedRoute('GET', '/api/v2/libs/search', context7Routes)).not.toBeNull();
      expect(matchAllowedRoute('POST', '/api/v2/libs/search', context7Routes)).not.toBeNull();
    });

    test('matches GET and POST on context', () => {
      expect(matchAllowedRoute('GET', '/api/v2/context', context7Routes)).not.toBeNull();
      expect(matchAllowedRoute('POST', '/api/v2/context', context7Routes)).not.toBeNull();
    });

    test('rejects DELETE on context', () => {
      expect(matchAllowedRoute('DELETE', '/api/v2/context', context7Routes)).toBeNull();
    });
  });

  describe('edge cases', () => {
    test('empty allowed routes returns null', () => {
      expect(matchAllowedRoute('POST', '/search', [])).toBeNull();
    });

    test('root path "/"', () => {
      const routes: AllowedRoute[] = [{ path: '/', methods: ['GET'] }];
      expect(matchAllowedRoute('GET', '/', routes)).not.toBeNull();
    });

    test('returns first matching route when multiple could match', () => {
      const routes: AllowedRoute[] = [
        { path: '/api', methods: ['POST'], prefixMatch: true, billingToolName: 'first' },
        { path: '/api/v2', methods: ['POST'], billingToolName: 'second' },
      ];
      const result = matchAllowedRoute('POST', '/api/v2', routes);
      expect(result).not.toBeNull();
      expect(result!.billingToolName).toBe('first');
    });
  });

  describe('registry integrity', () => {
    test('proxy services registry contains expected services', () => {
      const serviceNames = Object.keys(getProxyServices()).sort();
      expect(serviceNames).toEqual(['anthropic', 'context7', 'crw', 'firecrawl', 'gemini', 'groq', 'openai', 'replicate', 'serper', 'tavily', 'xai']);
    });

    test('each service has required fields', () => {
      const allServices = getProxyServices();
      for (const [name, svc] of Object.entries(allServices)) {
        expect(svc.name).toBe(name);
        expect(svc.targetBaseUrl).toBeDefined();
        expect(typeof svc.getKortixApiKey).toBe('function');
        expect(svc.keyInjection).toBeDefined();
        expect(Array.isArray(svc.allowedRoutes)).toBe(true);
        expect(svc.allowedRoutes.length).toBeGreaterThan(0);
        expect(svc.billingToolName).toBeDefined();
      }
    });
  });
});
