import { DISCOVERY_PATHS } from './link-header';
import {
  API_BASE,
  OAUTH_ENDPOINTS,
  OAUTH_ISSUER,
  OAUTH_SCOPES_SUPPORTED,
  OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE,
  siteUrl,
} from './endpoints';

/**
 * Agent registration instructions (workos.com/auth-md). Everything here is
 * derived from the same constants as the two well-known OAuth documents, so
 * the three cannot drift apart.
 */
export function renderAuthMd(): string {
  return `# Authenticating agents with Kortix

Kortix exposes a REST API at ${API_BASE}. Access is granted through an
OAuth 2.0 authorization code flow with mandatory PKCE.

## Endpoints

| Purpose | URL |
| --- | --- |
| Authorization | ${OAUTH_ENDPOINTS.authorization} |
| Token | ${OAUTH_ENDPOINTS.token} |
| User info | ${OAUTH_ENDPOINTS.userinfo} |

Issuer: ${OAUTH_ISSUER}

## Flow

1. Redirect the user to the authorization endpoint with \`response_type=code\`,
   your \`client_id\`, a registered \`redirect_uri\`, the scopes you need, and a
   \`code_challenge\`.
2. PKCE is required. \`code_challenge_method=S256\` is the only accepted method;
   a request without a challenge is rejected with \`invalid_request\`.
3. Exchange the returned code at the token endpoint. Send \`client_id\` and
   \`client_secret\` in the form body (\`client_secret_post\`).
4. Call the API with \`Authorization: Bearer <access_token>\`.
5. Refresh with \`grant_type=refresh_token\` when the access token expires.

The token endpoint is rate limited to ${OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE}
requests per minute per client.

## Scopes

${OAUTH_SCOPES_SUPPORTED.map((scope) => `- \`${scope}\``).join('\n')}

## Getting credentials

Kortix has **no dynamic client registration** endpoint. OAuth clients are
provisioned by the Kortix team rather than self-service, so an agent cannot mint
its own credentials. Request a client at ${siteUrl('/contact')} and include the
redirect URIs and scopes you need.

## Machine-readable companions

- ${siteUrl(DISCOVERY_PATHS.authorizationServer)}
- ${siteUrl(DISCOVERY_PATHS.protectedResource)}
- ${siteUrl(DISCOVERY_PATHS.apiCatalog)}
- ${siteUrl(DISCOVERY_PATHS.llmsTxt)}
`;
}
