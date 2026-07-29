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
}

export async function getAccountDeletionStatus(): Promise<AccountDeletionStatus | null> {
  const response = await backendApi.get<AccountDeletionStatus>('/account/deletion-status', {
    showErrors: false,
  });
  if (response.error?.status === 404) return null;
  return unwrap(response, 'Failed to load account deletion status');
}

export async function requestAccountDeletion(
  reason = 'User requested deletion',
): Promise<AccountDeletionMutationResult> {
  return unwrap(
    await backendApi.post<AccountDeletionMutationResult>(
      '/account/request-deletion',
      { reason },
      { showErrors: false },
    ),
    'Failed to request account deletion',
  );
}

export async function cancelAccountDeletion(): Promise<AccountDeletionMutationResult> {
  return unwrap(
    await backendApi.post<AccountDeletionMutationResult>(
      '/account/cancel-deletion',
      undefined,
      { showErrors: false },
    ),
    'Failed to cancel account deletion',
  );
}

export async function deleteAccountImmediately(): Promise<AccountDeletionMutationResult> {
  return unwrap(
    await backendApi.delete<AccountDeletionMutationResult>('/account/delete-immediately', {
      showErrors: false,
    }),
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
