/**
 * Public-origin drift for dynamically registered OAuth2 clients.
 *
 * An RFC 7591 client is registered with ONE redirect URI, and the
 * authorization server byte-matches every authorize request against it. When
 * Kortix's public origin changes between registration and authorize — a
 * rotated dev quick tunnel, a domain move — the server answers
 * "Invalid redirect URI" and the user dead-ends on the provider's error page
 * (Canva MCP, 2026-09-14). These helpers detect the drift before the
 * redirect and build the healed application from a freshly issued client.
 */
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import type { RegisteredOAuth2Client } from './oauth2-registration';

/**
 * Drift exists only when it is both real (a recorded redirect URI that no
 * longer matches) and healable (an RFC 7591 endpoint to re-register at).
 * Manually configured clients and legacy rows claim nothing.
 */
export function oauth2RedirectDrifted(
  application: OAuth2ApplicationInput,
  callbackUrl: string,
): boolean {
  return Boolean(
    application.redirect_uri &&
      application.registration_endpoint &&
      application.redirect_uri !== callbackUrl,
  );
}

/**
 * The stored application with the stale client identity replaced wholesale by
 * the freshly issued one. Endpoints, issuer, scopes and params survive — only
 * the client (id, secret, auth method, RFC 7592 handles) was reissued, so a
 * public fresh client must also DROP the stale secret and handles rather than
 * inherit them.
 */
export function reregisteredOAuth2Application(
  application: OAuth2ApplicationInput,
  issued: RegisteredOAuth2Client,
  callbackUrl: string,
): OAuth2ApplicationInput {
  const {
    client_secret: _staleSecret,
    registration_client_uri: _staleUri,
    registration_access_token: _staleToken,
    ...kept
  } = application;
  return {
    ...kept,
    client_id: issued.client_id,
    token_endpoint_auth_method: issued.token_endpoint_auth_method,
    redirect_uri: callbackUrl,
    ...(issued.client_secret ? { client_secret: issued.client_secret } : {}),
    ...(issued.registration_client_uri
      ? { registration_client_uri: issued.registration_client_uri }
      : {}),
    ...(issued.registration_access_token
      ? { registration_access_token: issued.registration_access_token }
      : {}),
  };
}
