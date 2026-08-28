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
import { OAUTH_SCOPES } from './access-token';

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
    registration_endpoint: `${issuer}/v1/accounts/{accountId}/iam/oauth-clients`,
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
