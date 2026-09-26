/**
 * Where `SetCredentialModal` writes a credential, and how it keys the OAuth2
 * discovery it runs. The modal is mounted once and retargeted per account
 * (`connectionId` + `owner`), so both answers must follow the selected account.
 */

export type CredentialWriteTarget =
  /** `PUT /projects/:id/connections/:connectionId/credential`. */
  | { kind: 'connection'; connectionId: string }
  /** A personal account not created yet: reconcile it, then write through it. */
  | { kind: 'resolve-connection' }
  /** `PUT /connectors/projects/:id/connectors/:slug/credential` — the connector's default shared slot. */
  | { kind: 'connector-default' };

export function credentialWriteTarget(
  owner: 'project' | 'me',
  connectionId: string | null,
): CredentialWriteTarget {
  // A selected account — shared or personal — is written through its own
  // connection. The per-connector route writes the default shared slot, which
  // is a different account whenever a connector has more than one.
  if (connectionId) return { kind: 'connection', connectionId };
  return owner === 'me' ? { kind: 'resolve-connection' } : { kind: 'connector-default' };
}

/**
 * The per-connection part of the discovery query key. The cached result
 * carries the connection id one-click OAuth then starts on, so it must never
 * be served for a different account. An account not created yet is keyed by
 * its owner: the shared default and a new personal account resolve to
 * different connections.
 */
export function oauth2DiscoveryConnectionKey(
  owner: 'project' | 'me',
  connectionId: string | null,
): string {
  return connectionId ?? `new:${owner}`;
}
