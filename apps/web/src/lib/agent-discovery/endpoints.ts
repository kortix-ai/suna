import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

export const API_ORIGIN = 'https://api.kortix.com';
export const API_BASE = `${API_ORIGIN}/v1`;

export const OPENAPI_URL = `${API_BASE}/openapi.json`;
export const API_HEALTH_URL = `${API_BASE}/health`;
export const AGENT_INDEX_URL = `${CANONICAL_ORIGIN}/api/ai`;

/**
 * RFC 8414 §3 requires only that the metadata *document location* derive from
 * the issuer identifier; the endpoints it advertises may live on any host. So
 * the issuer is the web origin (metadata at
 * kortix.com/.well-known/oauth-authorization-server) while the endpoints are on
 * api.kortix.com. Kortix access tokens are opaque database rows with no `iss`
 * claim, so nothing can contradict this identifier.
 */
export const OAUTH_ISSUER = CANONICAL_ORIGIN;

export const OAUTH_ENDPOINTS = {
  authorization: `${API_BASE}/oauth/authorize`,
  token: `${API_BASE}/oauth/token`,
  userinfo: `${API_BASE}/oauth/userinfo`,
} as const;

/**
 * Only scopes the API actually enforces. `machines:read` appears in test
 * fixtures but is gated by nothing, so advertising it would invite agents to
 * request a scope that grants no additional access.
 */
export const OAUTH_SCOPES_SUPPORTED = ['profile'] as const;

export const OAUTH_RESPONSE_TYPES = ['code'] as const;
export const OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export const OAUTH_CODE_CHALLENGE_METHODS = ['S256'] as const;
export const OAUTH_TOKEN_AUTH_METHODS = ['client_secret_post'] as const;

/** The token endpoint's per-client limit, mirrored into auth.md. */
export const OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE = 20;

/**
 * Deliberately not `absoluteUrl` from `@/lib/seo/public-content`: that module
 * reads MDX sources with `node:fs`, and pulling it into every discovery route
 * would couple them to the content pipeline for one string concatenation.
 */
export function siteUrl(path: string): string {
  return `${CANONICAL_ORIGIN}${path === '/' ? '' : path}`;
}
