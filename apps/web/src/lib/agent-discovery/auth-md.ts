import { DISCOVERY_PATHS } from './link-header';
import {
  API_BASE,
  OAUTH_CODE_CHALLENGE_METHODS,
  OAUTH_ENDPOINTS,
  OAUTH_GRANT_TYPES,
  OAUTH_ISSUER,
  OAUTH_SCOPES_SUPPORTED,
  OAUTH_TOKEN_AUTH_METHODS,
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
2. PKCE is required. \`code_challenge_method=${OAUTH_CODE_CHALLENGE_METHODS[0]}\`
   is the only accepted method; a request without a challenge is rejected with
   \`invalid_request\`.
3. Exchange the code at the token endpoint with \`grant_type=${OAUTH_GRANT_TYPES[0]}\`,
   \`code\`, \`redirect_uri\`, \`code_verifier\`, \`client_id\`, and \`client_secret\`
   (\`${OAUTH_TOKEN_AUTH_METHODS[0]}\`) in the form body — all six are required, or the
   request is rejected with \`invalid_request\`. \`code_verifier\` is the plaintext
   secret behind the ${OAUTH_CODE_CHALLENGE_METHODS[0]} \`code_challenge\` from step 1.
4. Call the API with \`Authorization: Bearer <access_token>\`.
5. Refresh with \`grant_type=${OAUTH_GRANT_TYPES[1]}\` plus \`refresh_token\`,
   \`client_id\`, and \`client_secret\` in the form body when the access token expires.

The token endpoint is rate limited to ${OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE}
requests per minute per client.

## Scopes

${OAUTH_SCOPES_SUPPORTED.map((scope) => `- \`${scope}\``).join('\n')}

## Bearer token credentials

Most agents do not need the flow above. Two credentials are self-service and
work as a plain \`Authorization: Bearer <token>\` header, no browser redirect:

- **Personal access token** (\`kortix_pat_\` prefix) — acts as the user who
  created it. Create one at **User settings → API keys**.
- **Service account** (\`kortix_sa_\` prefix) — a non-human credential for
  server-to-server callers. Create one at **Account settings → Service
  accounts**. A new service account has **no project access**; calls return
  \`403\` until an account admin grants it one.

Full detail, including scoping and rotation: ${siteUrl('/docs/sdk/auth')}.

Use a personal access token or service account for non-interactive,
server-to-server work. Use the OAuth flow above only to act on behalf of a
signed-in user who must approve the access.

## Getting an OAuth client

Kortix has **no dynamic client registration** endpoint. OAuth clients are
provisioned by the Kortix team rather than self-service, so an agent cannot mint
its own OAuth credentials. Request a client at ${siteUrl('/contact')} and
include the redirect URIs and scopes you need.

## Machine-readable companions

- ${siteUrl(DISCOVERY_PATHS.authorizationServer)}
- ${siteUrl(DISCOVERY_PATHS.protectedResource)}
- ${siteUrl(DISCOVERY_PATHS.apiCatalog)}
- ${siteUrl(DISCOVERY_PATHS.llmsTxt)}
`;
}
