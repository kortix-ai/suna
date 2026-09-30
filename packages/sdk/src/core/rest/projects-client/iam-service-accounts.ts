import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';

// ─── Service accounts (non-human IAM principals) ─────────────────────────

export interface ServiceAccount {
  service_account_id: string;
  name: string;
  description: string | null;
  public_prefix: string;
  status: 'active' | 'disabled';
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

export interface CreatedServiceAccount extends ServiceAccount {
  /** Plaintext bearer — shown ONCE at create. Store it now or rotate. */
  secret: string;
}

export async function listServiceAccountsApi(accountId: string) {
  return unwrap(
    await iamGet<{ service_accounts: ServiceAccount[] }>(
      `/accounts/${accountId}/iam/service-accounts`,
    ),
  ).service_accounts;
}

export async function createServiceAccountApi(
  accountId: string,
  input: { name: string; description?: string; expires_at?: string },
) {
  return unwrap(
    await backendApi.post<CreatedServiceAccount>(
      `/accounts/${accountId}/iam/service-accounts`,
      input,
      { showErrors: false },
    ),
  );
}

export async function disableServiceAccountApi(accountId: string, saId: string) {
  return unwrap(
    await backendApi.post<{ disabled: boolean }>(
      `/accounts/${accountId}/iam/service-accounts/${saId}/disable`,
      {},
      { showErrors: false },
    ),
  );
}

export async function deleteServiceAccountApi(accountId: string, saId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/service-accounts/${saId}`,
    ),
  );
}
