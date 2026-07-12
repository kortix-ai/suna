// Agent-minted SETUP LINKS — short-lived links the in-sandbox agent mints so
// a human can (a) enter a project secret VALUE, or (b) 1-click connect a
// Pipedream app, without the agent ever seeing the value/credential itself.
// See apps/api/src/projects/routes/setup-links.ts for the server-side handlers.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface RequestProjectSecretInput {
  /** One or more env var names to request (A-Z, 0-9, _; max 64 chars each). */
  names: string[];
  /** Optional per-name display label, keyed by name. */
  labels?: Record<string, string>;
  /** Optional per-name description, keyed by name. */
  descriptions?: Record<string, string>;
  /** `'runtime'` (project secret, default) or `'connector'` (connector credential). */
  scope?: 'runtime' | 'connector';
  expiresInMinutes?: number;
}

export interface SecretRequestLink {
  kind: 'secret';
  url: string;
  names: string[];
  scope: 'runtime' | 'connector';
  expires_at: string;
}

/** Mint a link a human opens to enter one or more secret values. */
export async function requestProjectSecret(
  projectId: string,
  input: RequestProjectSecretInput,
): Promise<SecretRequestLink> {
  return unwrap(
    await backendApi.post<SecretRequestLink>(`/projects/${projectId}/secret-requests`, {
      names: input.names,
      labels: input.labels,
      descriptions: input.descriptions,
      scope: input.scope,
      expires_in_minutes: input.expiresInMinutes,
    }),
    'Failed to mint secret-entry link',
  );
}

export interface RequestProjectConnectorInput {
  /** The Pipedream connector slug (already declared in kortix.yaml). */
  slug: string;
  expiresInMinutes?: number;
}

export interface ConnectorRequestLink {
  kind: 'connector';
  url: string;
  slug: string;
  app: string;
  expires_at: string;
}

/** Mint a link a human opens to 1-click connect a Pipedream app (Quick Connect). */
export async function requestProjectConnector(
  projectId: string,
  input: RequestProjectConnectorInput,
): Promise<ConnectorRequestLink> {
  return unwrap(
    await backendApi.post<ConnectorRequestLink>(`/projects/${projectId}/connect-requests`, {
      slug: input.slug,
      expires_in_minutes: input.expiresInMinutes,
    }),
    'Failed to mint connect link',
  );
}
