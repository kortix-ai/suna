/**
 * RFC 8414 authorization-server metadata for "Sign in with Kortix".
 *
 * Served at `/.well-known/oauth-authorization-server` on the API origin and
 * mirrored under `/v1/oauth/.well-known/oauth-authorization-server` for edges
 * that route only `/v1/*`. The issuer is the configured public API origin
 * (`KORTIX_URL`), never the incoming request — a value a third party compares
 * against must come from configuration (learnings 2026-08-19).
 */
import { config } from '../config';
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
    service_documentation: `${issuer.replace(/api\./, '')}/docs/sdk/sign-in`,
  } as const;
}

// ─── MCP (RFC 9728 protected resource) ──────────────────────────────────────

const MCP_PATH = /^\/v1\/projects\/([0-9a-f-]{36})\/mcp$/i;

/** The canonical URL of a project's MCP endpoint — the OAuth `resource`. */
export function mcpResourceUrl(projectId: string, fallbackOrigin?: string): string {
  return `${oauthIssuer(fallbackOrigin)}/v1/projects/${projectId}/mcp`;
}

/** Where the RFC 9728 metadata for a project's MCP endpoint lives. */
export function mcpResourceMetadataUrl(projectId: string, fallbackOrigin?: string): string {
  return `${oauthIssuer(fallbackOrigin)}/.well-known/oauth-protected-resource/v1/projects/${projectId}/mcp`;
}

/** True when `resource` names a Kortix project MCP endpoint on this issuer. */
export function isMcpResource(resource: string, fallbackOrigin?: string): boolean {
  try {
    const url = new URL(resource);
    return url.origin === new URL(oauthIssuer(fallbackOrigin)).origin && MCP_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function mcpProtectedResourceMetadata(projectId: string, fallbackOrigin?: string) {
  return {
    resource: mcpResourceUrl(projectId, fallbackOrigin),
    authorization_servers: [oauthIssuer(fallbackOrigin)],
    scopes_supported: [OAUTH_SCOPE_KORTIX],
    bearer_methods_supported: ['header'],
    resource_name: 'Kortix',
  } as const;
}

