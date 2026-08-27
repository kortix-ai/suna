import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelAccountDeletion,
  deleteAccountImmediately,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from '@kortix/sdk';

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

const UNSUPPORTED_STATUS: AccountDeletionStatus = {
  has_pending_deletion: false,
  deletion_scheduled_for: null,
  requested_at: null,
  can_cancel: false,
  supported: false,
};

export function useAccountDeletionStatus() {
  return useQuery<AccountDeletionStatus>({
    queryKey: ACCOUNT_DELETION_QUERY_KEY,
    queryFn: async () => {
      const status = await getAccountDeletionStatus();
      return status ? { ...status, supported: true } : UNSUPPORTED_STATUS;
    },
    staleTime: 30000,
    refetchOnWindowFocus: true,
  });
}

export function useRequestAccountDeletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reason?: string) => requestAccountDeletion(reason),
    onSuccess: (data) => {
      successToast(data.message);

      queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
        has_pending_deletion: true,
        deletion_scheduled_for: data.deletion_scheduled_for ?? null,
        requested_at: new Date().toISOString(),
        can_cancel: data.can_cancel ?? false,
        supported: true,
      });
    },
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to request account deletion');
    },
  });
}

export function useCancelAccountDeletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: cancelAccountDeletion,
    onSuccess: (data) => {
      successToast(data.message);

      queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
        has_pending_deletion: false,
        deletion_scheduled_for: null,
        requested_at: null,
        can_cancel: false,
        supported: true,
      });
    },
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to cancel account deletion');
    },
  });
}

export function useDeleteAccountImmediately() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteAccountImmediately,
    onSuccess: (data) => {
      successToast(data.message);

      // Clear deletion status since account is gone
      queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
        has_pending_deletion: false,
        deletion_scheduled_for: null,
        requested_at: null,
        can_cancel: false,
        supported: true,
      });

      // Redirect to home or logout after a short delay
      setTimeout(() => {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Account deletion: the document load is the point, the signed-in tree and every cache belong to an account that no longer exists.
        window.location.href = '/';
      }, 2000);
    },
    onError: (error: Error) => {
      errorToast(error.message || 'Failed to delete account immediately');
    },
  });
}
