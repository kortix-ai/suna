import { DISCOVERY_PATHS } from './link-header';
import {
  API_BASE,
  OAUTH_CODE_CHALLENGE_METHODS,
  OAUTH_ENDPOINTS,
  OAUTH_GRANT_TYPES,
  OAUTH_ISSUER,
  OAUTH_RESPONSE_TYPES,
  OAUTH_SCOPES_SUPPORTED,
  OAUTH_TOKEN_AUTH_METHODS,
  siteUrl,
} from './endpoints';

type AgentAuth = {
  register_uri: string;
  identity_types: string[];
  credential_types: string[];
};

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
  agent_auth: AgentAuth;
};

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
};

/**
 * RFC 8414 metadata. Deliberately not an `openid-configuration`: Kortix issues
 * opaque database-backed tokens with no `id_token` and exposes no JWKS, so an
 * OIDC discovery document would advertise a flow that does not exist.
 */
export function buildAuthorizationServerMetadata(): AuthorizationServerMetadata {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: OAUTH_ENDPOINTS.authorization,
    token_endpoint: OAUTH_ENDPOINTS.token,
    userinfo_endpoint: OAUTH_ENDPOINTS.userinfo,
    response_types_supported: [...OAUTH_RESPONSE_TYPES],
    grant_types_supported: [...OAUTH_GRANT_TYPES],
    code_challenge_methods_supported: [...OAUTH_CODE_CHALLENGE_METHODS],
    token_endpoint_auth_methods_supported: [...OAUTH_TOKEN_AUTH_METHODS],
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    service_documentation: siteUrl(DISCOVERY_PATHS.docs),
    agent_auth: {
      // No dynamic client registration exists in apps/api/src/oauth/index.ts;
      // clients are provisioned out of band. Pointing at a real request path
      // beats inventing a /register that would 404.
      register_uri: siteUrl('/contact'),
      // This grant only ever mints a delegated end-user identity: every
      // access token traces back to the userId who approved the consent
      // screen, and apps/api/src/oauth/index.ts has no client_credentials
      // grant for a service account to call in on its own. Advertising
      // 'service_account' here would send an agent to POST
      // grant_type=client_credentials, which that endpoint answers with
      // unsupported_grant_type. Service accounts are a separate, non-OAuth
      // bearer-token credential documented in auth.md.
      identity_types: ['user'],
      credential_types: ['client_secret'],
    },
  };
}

/**
 * RFC 9728 metadata. Strictly this document derives from the resource
 * identifier and belongs at api.kortix.com/.well-known/oauth-protected-resource/v1;
 * serving it here is a discovery mirror. See the spec's follow-up list.
 */
export function buildProtectedResourceMetadata(): ProtectedResourceMetadata {
  return {
    resource: API_BASE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    bearer_methods_supported: ['header'],
    resource_documentation: siteUrl(DISCOVERY_PATHS.docs),
  };
}
