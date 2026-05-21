// Client wrappers for /v1/accounts/:accountId/vault/* — account-owned secrets
// with a "Who can use this?" visibility model. Values are NEVER returned by
// reads; only metadata. Mirrors the iam-client conventions.

import { backendApi } from '@/lib/api-client';

export type VaultVisibility = 'global' | 'private' | 'select';

export type VaultKind =
  | 'env'
  | 'api_key'
  | 'oauth_token'
  | 'oauth_client'
  | 'connection_secret';

export interface VaultItem {
  item_id: string;
  kind: VaultKind;
  name: string;
  project_id: string | null;
  owner_user_id: string;
  provider_id: string | null;
  visibility: VaultVisibility;
  grant_user_ids: string[];
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }) {
  if (!response.success || response.data === undefined) {
    throw response.error || new Error('Unexpected empty response');
  }
  return response.data;
}

// ─── Vault items ─────────────────────────────────────────────────────────────

export async function listVaultItems(
  accountId: string,
  opts: { projectId?: string | null } = {},
) {
  const params = new URLSearchParams();
  if (opts.projectId !== undefined) {
    params.set('project_id', opts.projectId === null ? 'null' : opts.projectId);
  }
  const qs = params.toString();
  return unwrap(
    await backendApi.get<{ items: VaultItem[] }>(
      `/accounts/${accountId}/vault${qs ? `?${qs}` : ''}`,
    ),
  );
}

export async function createVaultItem(
  accountId: string,
  input: {
    name: string;
    value: string;
    kind?: VaultKind;
    visibility: VaultVisibility;
    project_id?: string | null;
    grant_user_ids?: string[];
    provider_id?: string;
  },
) {
  return unwrap(
    await backendApi.post<{ item_id: string; name: string; visibility: VaultVisibility }>(
      `/accounts/${accountId}/vault`,
      input,
      { showErrors: false },
    ),
  );
}

export async function updateVaultItem(
  accountId: string,
  itemId: string,
  input: { value?: string; grant_user_ids?: string[] },
) {
  return unwrap(
    await backendApi.patch<{ ok: true }>(
      `/accounts/${accountId}/vault/${itemId}`,
      input,
      { showErrors: false },
    ),
  );
}

export async function deleteVaultItem(accountId: string, itemId: string) {
  return unwrap(
    await backendApi.delete<{ ok: true }>(`/accounts/${accountId}/vault/${itemId}`),
  );
}
