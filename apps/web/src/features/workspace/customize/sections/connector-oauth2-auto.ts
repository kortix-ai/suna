/**
 * One-click OAuth for a connector whose server publishes its own authorization
 * metadata (the MCP authorization chain, RFC 9728 + RFC 8414 + RFC 7591).
 *
 * The user's job shrinks to pressing one button: Kortix discovers the
 * authorization server, registers itself as a client, and starts the
 * Authorization Code + PKCE flow. These helpers are the pure decisions behind
 * that button, kept out of the component so they are testable on their own.
 */
import type { OAuth2ClientRegistrationInput, OAuth2ResourceDiscovery } from '@kortix/sdk';

import type { OAuth2ApplicationForm } from './connector-oauth2';

export type AutoConnectPlan =
  /** Discovery has not run yet. */
  | { kind: 'unknown' }
  /** The server answered without credentials — it needs no OAuth connection. */
  | { kind: 'no_authorization' }
  /** Everything is discoverable: register dynamically, then authorize. */
  | {
      kind: 'register';
      label: string;
      registrationEndpoint: string;
      scopes: string[];
    }
  /** Endpoints are known but the server has no dynamic registration. */
  | { kind: 'client_id_required'; label: string; scopes: string[] }
  /** Nothing usable was discovered — the fields must be filled in by hand. */
  | { kind: 'manual'; reason: string };

function resourceLabel(discovery: OAuth2ResourceDiscovery): string {
  if (discovery.resource_name) return `Connect ${discovery.resource_name}`;
  try {
    return `Connect ${new URL(discovery.resource ?? discovery.resource_url).host}`;
  } catch {
    return 'Connect';
  }
}

export function autoConnectPlan(
  discovery: OAuth2ResourceDiscovery | null | undefined,
): AutoConnectPlan {
  if (!discovery) return { kind: 'unknown' };
  if (!discovery.requires_authorization) return { kind: 'no_authorization' };
  if (!discovery.metadata?.token_url && !discovery.metadata?.authorization_url) {
    return {
      kind: 'manual',
      reason:
        discovery.warnings.at(-1) ??
        'This server does not publish OAuth 2.0 metadata. Enter its endpoints manually.',
    };
  }
  const label = resourceLabel(discovery);
  if (!discovery.registration_endpoint) {
    return { kind: 'client_id_required', label, scopes: discovery.scopes };
  }
  return {
    kind: 'register',
    label,
    registrationEndpoint: discovery.registration_endpoint,
    scopes: discovery.scopes,
  };
}

export function buildClientRegistrationInput(
  discovery: OAuth2ResourceDiscovery,
): OAuth2ClientRegistrationInput {
  if (!discovery.registration_endpoint) {
    throw new Error('This authorization server does not support dynamic client registration');
  }
  const metadata = discovery.metadata ?? {};
  return {
    registration_endpoint: discovery.registration_endpoint,
    ...(metadata.discovery_url ? { discovery_url: metadata.discovery_url } : {}),
    ...(metadata.authorization_url ? { authorization_url: metadata.authorization_url } : {}),
    ...(metadata.token_url ? { token_url: metadata.token_url } : {}),
    ...(metadata.device_authorization_url
      ? { device_authorization_url: metadata.device_authorization_url }
      : {}),
    ...(metadata.revocation_url ? { revocation_url: metadata.revocation_url } : {}),
    ...(discovery.token_endpoint_auth_methods_supported?.length
      ? {
          token_endpoint_auth_methods_supported:
            discovery.token_endpoint_auth_methods_supported,
        }
      : {}),
    ...(discovery.scopes.length ? { scopes: discovery.scopes } : {}),
    ...(discovery.resource ? { resource: discovery.resource } : {}),
  };
}

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
    deviceAuthorizationUrl:
      form.deviceAuthorizationUrl || metadata.device_authorization_url || '',
    revocationUrl: form.revocationUrl || metadata.revocation_url || '',
    scopes: form.scopes || discovery.scopes.join(' '),
    resource: form.resource || discovery.resource || '',
  };
}
