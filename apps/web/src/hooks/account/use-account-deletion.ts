import { performSignOut } from '@/lib/auth/perform-sign-out';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  cancelAccountDeletion,
  deleteAccountImmediately,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';

export interface AccountDeletionStatus {
  has_pending_deletion: boolean;
  deletion_scheduled_for: string | null;
  requested_at: string | null;
  can_cancel: boolean;
  supported: boolean;
}

export interface RequestDeletionResponse {
  success: boolean;
  message: string;
  deletion_scheduled_for: string;
  can_cancel: boolean;
}

export interface CancelDeletionResponse {
  success: boolean;
  message: string;
}

export interface DeleteImmediatelyResponse {
  success: boolean;
  message: string;
}

export const ACCOUNT_DELETION_QUERY_KEY = ['account', 'deletion-status'];

/** Cache key of one account's deletion status. Omit `accountId` for the
 *  caller's own (primary) account — the Profile tab's case — and every
 *  surface shares that one entry. The account hub scopes by the account it
 *  is open on. */
export function accountDeletionStatusKey(accountId?: string) {
  return accountId ? [...ACCOUNT_DELETION_QUERY_KEY, accountId] : ACCOUNT_DELETION_QUERY_KEY;
}

const UNSUPPORTED_STATUS: AccountDeletionStatus = {
  has_pending_deletion: false,
  deletion_scheduled_for: null,
  requested_at: null,
  can_cancel: false,
  supported: false,
};

export function useAccountDeletionStatus(accountId?: string) {
  return useQuery<AccountDeletionStatus>({
    queryKey: accountDeletionStatusKey(accountId),
    queryFn: async () => {
      const status = await getAccountDeletionStatus(accountId);
      return status ? { ...status, supported: true } : UNSUPPORTED_STATUS;
    },
    staleTime: 30000,
    refetchOnWindowFocus: true,
  });
}

export function useRequestAccountDeletion(accountId?: string) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reason?: string) => requestAccountDeletion(reason, accountId),
    onSuccess: (data) => {
      successToast(data.message);

      queryClient.setQueryData<AccountDeletionStatus>(accountDeletionStatusKey(accountId), {
        has_pending_deletion: true,
        deletion_scheduled_for: data.deletion_scheduled_for ?? null,
        requested_at: new Date().toISOString(),
        can_cancel: data.can_cancel ?? false,
        supported: true,
      });
    },
    onError: (error: Error) => {
      errorToast(error.message || tI18nComplete.raw('textf2bbdc88c314'));
    },
  });
}

export function useCancelAccountDeletion(accountId?: string) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => cancelAccountDeletion(accountId),
    onSuccess: (data) => {
      successToast(data.message);

      queryClient.setQueryData<AccountDeletionStatus>(accountDeletionStatusKey(accountId), {
        has_pending_deletion: false,
        deletion_scheduled_for: null,
        requested_at: null,
        can_cancel: false,
        supported: true,
      });
    },
    onError: (error: Error) => {
      errorToast(error.message || tI18nComplete.raw('textfe49d2d1f394'));
    },
  });
}

export function useDeleteAccountImmediately(accountId?: string) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  return useMutation({
    mutationFn: () => deleteAccountImmediately(accountId),
    onSuccess: async (data) => {
      successToast(data.message);
      // Deleting an account that is not the caller's own keeps them signed
      // in — the server says so. Absent field = a server that always deleted
      // the identity (every response before scoping existed).
      if (data.identity_deleted === false) return;
      await performSignOut();
    },
    onError: (error: Error) => {
      errorToast(error.message || tI18nComplete.raw('textb7ef1459725d'));
    },
  });
}
