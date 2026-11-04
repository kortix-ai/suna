/**
 * One-click OAuth for a connector whose server publishes its own authorization
 * metadata (the MCP authorization chain, RFC 9728 + RFC 8414 + RFC 7591).
 *
 * The user's job shrinks to pressing one button: Kortix discovers the
 * authorization server, registers itself as a client, and starts the
 * Authorization Code + PKCE flow. These helpers are the pure decisions behind
 * that button, kept out of the component so they are testable on their own.
 */
import type { OAuth2ResourceDiscovery } from '@kortix/sdk';

import type { OAuth2ApplicationForm } from './connector-oauth2';

/** One-click OAuth's plan and client registration live in `@kortix/sdk`. */
export {
  buildOAuth2ClientRegistrationInput as buildClientRegistrationInput,
  oauth2AutoConnectPlan as autoConnectPlan,
} from '@kortix/sdk';

/** Prefill the manual form from discovery. Anything the user typed wins. */
export function mergeResourceDiscoveryIntoForm(
  form: OAuth2ApplicationForm,
  discovery: OAuth2ResourceDiscovery,
): OAuth2ApplicationForm {
  const metadata = discovery.metadata ?? {};
  return {
    ...form,
    discoveryUrl: form.discoveryUrl || metadata.discovery_url || '',
    authorizationUrl: form.authorizationUrl || metadata.authorization_url || '',
    tokenUrl: form.tokenUrl || metadata.token_url || '',
    deviceAuthorizationUrl: form.deviceAuthorizationUrl || metadata.device_authorization_url || '',
    revocationUrl: form.revocationUrl || metadata.revocation_url || '',
    scopes: form.scopes || discovery.scopes.join(' '),
    resource: form.resource || discovery.resource || '',
  };
}
