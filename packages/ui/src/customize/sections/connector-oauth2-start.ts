import {
  discoverConnectionOAuth2Resource,
  registerConnectionOAuth2Client,
  startConnectionOAuth2Authorization,
  type OAuth2ResourceDiscovery,
} from '@kortix/sdk';

import { autoConnectPlan, buildClientRegistrationInput } from './connector-oauth2-auto';

/**
 * One-click OAuth: register Kortix as a client of the server's authorization
 * server, then start Authorization Code + PKCE. Returns the provider URL to
 * send the browser to. The provider sends the user back to `returnUrl`.
 */
export async function startOAuth2SignIn(
  projectId: string,
  connectionId: string,
  discovery: OAuth2ResourceDiscovery,
  returnUrl: string,
): Promise<string> {
  await registerConnectionOAuth2Client(
    projectId,
    connectionId,
    buildClientRegistrationInput(discovery),
  );
  const result = await startConnectionOAuth2Authorization(projectId, connectionId, {
    ...(discovery.scopes.length ? { scopes: discovery.scopes } : {}),
    success_redirect_uri: returnUrl,
    error_redirect_uri: returnUrl,
  });
  return result.authorization_url;
}

/**
 * Install's sign-in: discover the server's authorization chain and, when it
 * supports one-click OAuth, start it. `null` when it does not, so the caller
 * falls back to credential entry.
 */
export async function startDiscoveredSignIn(
  projectId: string,
  connectionId: string,
  returnUrl: string,
): Promise<string | null> {
  const { discovery } = await discoverConnectionOAuth2Resource(projectId, connectionId);
  if (autoConnectPlan(discovery).kind !== 'register') return null;
  return startOAuth2SignIn(projectId, connectionId, discovery, returnUrl);
}

/**
 * A sign-in start for a flow that falls back to credential entry: the consent
 * URL, or why there is none. A failed start keeps the server's reason, so the
 * fallback can say why it asks for a credential.
 */
export async function signInOrReason(
  start: () => Promise<string | null>,
): Promise<{ url: string | null; error: string | null }> {
  try {
    return { url: await start(), error: null };
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : String(error) };
  }
}
