import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '@/api/config';
import { supabase } from '@/api/supabase';

// Ported from web's use-account-deletion.ts (commit 325e62d).
// Talks to the same backend routes mounted at /v1/account/*.

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

async function getAuthHeaders() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        throw new Error('Not authenticated');
    }
    return {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
    };
}

async function safeJson(response: Response): Promise<any> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

export function useAccountDeletionStatus(options?: { enabled?: boolean }) {
    return useQuery<AccountDeletionStatus>({
        queryKey: ACCOUNT_DELETION_QUERY_KEY,
        queryFn: async () => {
            const headers = await getAuthHeaders();

            const response = await fetch(`${API_URL}/account/deletion-status`, {
                headers,
            });

            // 404 = endpoint not mounted (self-hosted without billing)
            if (response.status === 404) {
                return UNSUPPORTED_STATUS;
            }

            if (!response.ok) {
                return {
                    ...UNSUPPORTED_STATUS,
                    supported: true,
                };
            }

            const data = (await safeJson(response)) as Partial<AccountDeletionStatus> | null;
            if (!data) {
                return {
                    ...UNSUPPORTED_STATUS,
                    supported: true,
                };
            }

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
        mutationFn: async (reason?: string) => {
            const headers = await getAuthHeaders();

            const response = await fetch(`${API_URL}/account/request-deletion`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ reason: reason || 'User requested deletion' }),
            });

            if (response.status === 404) {
                throw new Error('Account deletion is not available in this environment yet.');
            }

            if (!response.ok) {
                const error = await safeJson(response);
                throw new Error(error?.message || error?.error || 'Failed to request account deletion');
            }

            return (await response.json()) as RequestDeletionResponse;
        },
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
        mutationFn: async () => {
            const headers = await getAuthHeaders();

            const response = await fetch(`${API_URL}/account/cancel-deletion`, {
                method: 'POST',
                headers,
            });

            if (response.status === 404) {
                throw new Error('Account deletion is not available in this environment yet.');
            }

            if (!response.ok) {
                const error = await safeJson(response);
                throw new Error(error?.message || error?.error || 'Failed to cancel account deletion');
            }

            return (await response.json()) as CancelDeletionResponse;
        },
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
        mutationFn: async () => {
            const headers = await getAuthHeaders();

            const response = await fetch(`${API_URL}/account/delete-immediately`, {
                method: 'DELETE',
                headers,
            });

            if (response.status === 404) {
                throw new Error('Account deletion is not available in this environment yet.');
            }

            if (!response.ok) {
                const error = await safeJson(response);
                throw new Error(error?.message || error?.error || 'Failed to delete account immediately');
            }

            return (await response.json()) as DeleteImmediatelyResponse;
        },
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
            supabase.auth.signOut().catch(() => {});

            // Clear all cached data
            queryClient.clear();
        },
    });
}
