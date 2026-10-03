import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface AccountDeletionStatus {
  has_pending_deletion: boolean;
  deletion_scheduled_for: string | null;
  requested_at: string | null;
  can_cancel: boolean;
}

export interface AccountDeletionMutationResult {
  success: boolean;
  message: string;
  deletion_scheduled_for?: string;
  can_cancel?: boolean;
  /**
   * `delete-immediately` only: whether the caller's auth identity was deleted
   * with the account. Deleting an account the caller does not treat as their
   * own (an explicit `accountId` that is not their primary) keeps the identity,
   * so hosts must not sign the user out. Absent on older responses, which
   * always deleted the identity — treat absent as `true`.
   */
  identity_deleted?: boolean;
}

/** `?account_id=` for the one account-scoped argument these routes take. */
function accountQuery(accountId: string | undefined): string {
  return accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
}

export async function getAccountDeletionStatus(
  accountId?: string,
): Promise<AccountDeletionStatus | null> {
  const response = await backendApi.get<AccountDeletionStatus>(
    `/account/deletion-status${accountQuery(accountId)}`,
    { showErrors: false },
  );
  if (response.error?.status === 404) return null;
  return unwrap(response, 'Failed to load account deletion status');
}

export async function requestAccountDeletion(
  reason = 'User requested deletion',
  accountId?: string,
): Promise<AccountDeletionMutationResult> {
  return unwrap(
    await backendApi.post<AccountDeletionMutationResult>(
      '/account/request-deletion',
      accountId ? { reason, account_id: accountId } : { reason },
      { showErrors: false },
    ),
    'Failed to request account deletion',
  );
}

export async function cancelAccountDeletion(
  accountId?: string,
): Promise<AccountDeletionMutationResult> {
  return unwrap(
    await backendApi.post<AccountDeletionMutationResult>(
      '/account/cancel-deletion',
      accountId ? { account_id: accountId } : undefined,
      { showErrors: false },
    ),
    'Failed to cancel account deletion',
  );
}

export async function deleteAccountImmediately(
  accountId?: string,
): Promise<AccountDeletionMutationResult> {
  return unwrap(
    await backendApi.delete<AccountDeletionMutationResult>(
      `/account/delete-immediately${accountQuery(accountId)}`,
      { showErrors: false },
    ),
    'Failed to delete account immediately',
  );
}

export interface AdminRole {
  isAdmin: boolean;
  role?: 'admin' | 'super_admin' | null;
}

export async function getAdminRole(): Promise<AdminRole> {
  const response = await backendApi.get<AdminRole>('/user-roles', { showErrors: false });
  return response.data ?? { isAdmin: false, role: null };
}
