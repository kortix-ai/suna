/**
 * RFC 8414 authorization-server metadata for "Sign in with Kortix".
 *
 * Served at `/.well-known/oauth-authorization-server` on the API origin and
 * mirrored under `/v1/oauth/.well-known/oauth-authorization-server` for edges
 * that route only `/v1/*`. The issuer is the configured public API origin
 * (`KORTIX_URL`), never the incoming request — a value a third party compares
 * against must come from configuration (learnings 2026-08-19).
 */
import { config } from '../../lib/config';
import { OAUTH_SCOPE_KORTIX, OAUTH_SCOPES } from './access-token';

export function oauthIssuer(fallbackOrigin?: string): string {
  const configured = (config.KORTIX_URL || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  return configured || (fallbackOrigin ?? '').replace(/\/+$/, '');
}

export function oauthAuthorizationServerMetadata(fallbackOrigin?: string) {
  const issuer = oauthIssuer(fallbackOrigin);
  const base = `${issuer}/v1/oauth`;
  return {
    issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    revocation_endpoint: `${base}/revoke`,
    userinfo_endpoint: `${base}/userinfo`,
    // RFC 7591 open registration (public PKCE clients: MCP clients register
    // themselves). Accounts still register managed clients under
    // /v1/accounts/:accountId/iam/oauth-clients.
    registration_endpoint: `${base}/register`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/docs/sdk/sign-in`,
  } as const;
}

// ─── MCP (RFC 9728 protected resource) ──────────────────────────────────────

/** The canonical URL of the MCP endpoint — the OAuth `resource`. One per issuer. */
export function mcpResourceUrl(fallbackOrigin?: string): string {
  return `${oauthIssuer(fallbackOrigin)}/v1/mcp`;
}

/** Where the RFC 9728 metadata for the MCP endpoint lives. */
export function mcpResourceMetadataUrl(fallbackOrigin?: string): string {
  return `${oauthIssuer(fallbackOrigin)}/.well-known/oauth-protected-resource/v1/mcp`;
}

/** True when `resource` names the Kortix MCP endpoint on this issuer. */
export function isMcpResource(resource: string, fallbackOrigin?: string): boolean {
  try {
    return new URL(resource).href.replace(/\/+$/, '') === mcpResourceUrl(fallbackOrigin);
  } catch {
    return false;
  }
}

export function mcpProtectedResourceMetadata(fallbackOrigin?: string) {
  return {
    resource: mcpResourceUrl(fallbackOrigin),
    authorization_servers: [oauthIssuer(fallbackOrigin)],
    scopes_supported: [OAUTH_SCOPE_KORTIX],
    bearer_methods_supported: ['header'],
    resource_name: 'Kortix',
  } as const;
}
