import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';

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

function isUnsupportedEndpoint(error: { status?: number; code?: string } | undefined): boolean {
    return error?.status === 404 || error?.code === '404';
}

export function useAccountDeletionStatus() {
    return useQuery<AccountDeletionStatus>({
        queryKey: ACCOUNT_DELETION_QUERY_KEY,
        queryFn: async () => {
            const response = await backendApi.get<AccountDeletionStatus>('/account/deletion-status', {
                showErrors: false
            });

            if (isUnsupportedEndpoint(response.error)) {
                return UNSUPPORTED_STATUS;
            }

            if (!response.success || !response.data) {
                return {
                    ...UNSUPPORTED_STATUS,
                    supported: true,
                };
            }

            return {
                ...response.data,
                supported: true,
            };
        },
        staleTime: 30000,
        refetchOnWindowFocus: true,
    });
}

export function useRequestAccountDeletion() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (reason?: string) => {
            const response = await backendApi.post<RequestDeletionResponse>('/account/request-deletion', {
                reason: reason || 'User requested deletion'
            }, {
                showErrors: false,
            });

            if (isUnsupportedEndpoint(response.error)) {
                throw new Error('Account deletion is not available in this environment yet.');
            }

            if (!response.success || !response.data) {
                throw new Error(response.error?.message || 'Failed to request account deletion');
            }

            return response.data;
        },
        onSuccess: (data) => {
            toast.success(data.message);
            
            queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
                has_pending_deletion: true,
                deletion_scheduled_for: data.deletion_scheduled_for,
                requested_at: new Date().toISOString(),
                can_cancel: data.can_cancel,
                supported: true,
            });
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to request account deletion');
        }
    });
}

export function useCancelAccountDeletion() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async () => {
            const response = await backendApi.post<CancelDeletionResponse>('/account/cancel-deletion', undefined, {
                showErrors: false,
            });

            if (isUnsupportedEndpoint(response.error)) {
                throw new Error('Account deletion is not available in this environment yet.');
            }

            if (!response.success || !response.data) {
                throw new Error(response.error?.message || 'Failed to cancel account deletion');
            }

            return response.data;
        },
        onSuccess: (data) => {
            toast.success(data.message);
            
            queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
                has_pending_deletion: false,
                deletion_scheduled_for: null,
                requested_at: null,
                can_cancel: false,
                supported: true,
            });
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to cancel account deletion');
        }
    });
}

export function useDeleteAccountImmediately() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async () => {
            const response = await backendApi.delete<DeleteImmediatelyResponse>('/account/delete-immediately', {
                showErrors: false,
            });

            if (isUnsupportedEndpoint(response.error)) {
                throw new Error('Account deletion is not available in this environment yet.');
            }

            if (!response.success || !response.data) {
                throw new Error(response.error?.message || 'Failed to delete account immediately');
            }

            return response.data;
        },
        onSuccess: (data) => {
            toast.success(data.message);
            
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
                window.location.href = '/';
            }, 2000);
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to delete account immediately');
        }
    });
}
