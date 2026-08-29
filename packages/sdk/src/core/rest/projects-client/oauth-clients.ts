/**
 * OAuth clients — the "Sign in with Kortix" app registry.
 *
 * `POST /accounts/{id}/iam/oauth-clients` registers an app that signs Kortix
 * users in through `/v1/oauth`. The response carries `client_secret` exactly
 * once (confidential clients only); list/get never do. Pair the id + secret
 * with `createKortixAuth` from `@kortix/sdk/server`.
 */
import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type OAuthClientType = 'confidential' | 'public';

/** `profile`/`email` identify the user; `kortix` lets the app act as them on the API. */
export type OAuthScope = 'profile' | 'email' | 'kortix';

export interface OAuthClient {
  client_id: string;
  name: string;
  description: string | null;
  client_type: OAuthClientType;
  redirect_uris: string[];
  scopes: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreatedOAuthClient extends OAuthClient {
  /** Shown ONCE. `null` for a public client. */
  client_secret: string | null;
}

export interface CreateOAuthClientInput {
  name: string;
  description?: string;
  /** Default `confidential`. A `public` client (browser/native) gets no secret and relies on PKCE. */
  client_type?: OAuthClientType;
  /** Absolute https URLs (http only on localhost), compared byte-for-byte at sign-in. */
  redirect_uris: string[];
  /** Default: every scope (`profile`, `email`, `kortix`). */
  scopes?: OAuthScope[] | string[];
}

export interface UpdateOAuthClientInput {
  name?: string;
  description?: string | null;
  redirect_uris?: string[];
  scopes?: OAuthScope[] | string[];
  active?: boolean;
}

export async function listOAuthClients(accountId: string) {
  return unwrap(
    await backendApi.get<{ oauth_clients: OAuthClient[]; scopes_supported: string[] }>(
      `/accounts/${accountId}/iam/oauth-clients`,
      { showErrors: false },
    ),
  );
}

export async function getOAuthClient(accountId: string, clientId: string) {
  return unwrap(
    await backendApi.get<OAuthClient>(`/accounts/${accountId}/iam/oauth-clients/${clientId}`, { showErrors: false }),
  );
}

export async function createOAuthClient(accountId: string, input: CreateOAuthClientInput) {
  return unwrap(
    await backendApi.post<CreatedOAuthClient>(`/accounts/${accountId}/iam/oauth-clients`, input, { showErrors: false }),
  );
}

export async function updateOAuthClient(accountId: string, clientId: string, input: UpdateOAuthClientInput) {
  return unwrap(
    await backendApi.patch<OAuthClient>(`/accounts/${accountId}/iam/oauth-clients/${clientId}`, input, {
      showErrors: false,
    }),
  );
}

export async function rotateOAuthClientSecret(accountId: string, clientId: string) {
  return unwrap(
    await backendApi.post<CreatedOAuthClient>(
      `/accounts/${accountId}/iam/oauth-clients/${clientId}/rotate-secret`,
      {},
      { showErrors: false },
    ),
  );
}

export async function deleteOAuthClient(accountId: string, clientId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(`/accounts/${accountId}/iam/oauth-clients/${clientId}`, {
      showErrors: false,
    }),
  );
}
