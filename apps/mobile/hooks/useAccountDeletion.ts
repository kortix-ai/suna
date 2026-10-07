import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    cancelAccountDeletion,
    deleteAccountImmediately,
    getAccountDeletionStatus,
    requestAccountDeletion,
} from '@kortix/sdk';
import { supabase } from '@/api/supabase';
import { sessionExpiry } from '@/lib/auth/session-expiry-monitor';
import { signOutThisDevice } from '@/lib/auth/sign-out';

// Backed by the `@kortix/sdk` account-lifecycle calls (/v1/account/*): deadline,
// 401 replay and typed `ApiError` come from the SDK transport.

export interface AccountDeletionStatus {
    has_pending_deletion: boolean;
    deletion_scheduled_for: string | null;
    requested_at: string | null;
    can_cancel: boolean;
    /** False when the backend doesn't expose account deletion (e.g. self-hosted without billing) */
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

const NOT_AVAILABLE = 'Account deletion is not available in this environment yet.';

/** A 404 means the endpoint is not mounted (self-hosted without billing). */
async function mutate<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if ((error as { status?: number } | null)?.status === 404) throw new Error(NOT_AVAILABLE);
        throw error;
    }
}

export function useAccountDeletionStatus(options?: { enabled?: boolean }) {
    return useQuery<AccountDeletionStatus>({
        queryKey: ACCOUNT_DELETION_QUERY_KEY,
        queryFn: async () => {
            let data: Awaited<ReturnType<typeof getAccountDeletionStatus>>;
            try {
                data = await getAccountDeletionStatus();
            } catch {
                return { ...UNSUPPORTED_STATUS, supported: true };
            }
            // null = 404: endpoint not mounted (self-hosted without billing)
            if (!data) return UNSUPPORTED_STATUS;

            return {
                has_pending_deletion: !!data.has_pending_deletion,
                deletion_scheduled_for: data.deletion_scheduled_for ?? null,
                requested_at: data.requested_at ?? null,
                can_cancel: !!data.can_cancel,
                supported: true,
            };
        },
        staleTime: 30000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        ...options,
    });
}

export function useRequestAccountDeletion() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (reason?: string) =>
            (await mutate(() => requestAccountDeletion(reason || 'User requested deletion'))) as RequestDeletionResponse,
        onSuccess: (data) => {
            queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
                has_pending_deletion: true,
                deletion_scheduled_for: data.deletion_scheduled_for,
                requested_at: new Date().toISOString(),
                can_cancel: data.can_cancel,
                supported: true,
            });
        },
    });
}

export function useCancelAccountDeletion() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async () => (await mutate(() => cancelAccountDeletion())) as CancelDeletionResponse,
        onSuccess: () => {
            queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
                has_pending_deletion: false,
                deletion_scheduled_for: null,
                requested_at: null,
                can_cancel: false,
                supported: true,
            });
        },
    });
}

export function useDeleteAccountImmediately() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async () => (await mutate(() => deleteAccountImmediately())) as DeleteImmediatelyResponse,
        onSuccess: () => {
            // Clear deletion status since account is gone
            queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
                has_pending_deletion: false,
                deletion_scheduled_for: null,
                requested_at: null,
                can_cancel: false,
                supported: true,
            });

            // Sign out locally — the server has already deleted the account
            sessionExpiry.disarm();
            void signOutThisDevice(supabase.auth);

            // Clear all cached data
            queryClient.clear();
        },
    });
}
