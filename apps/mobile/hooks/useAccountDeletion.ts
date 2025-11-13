import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '@/api/config';
import { supabase } from '@/api/supabase';

export interface AccountDeletionStatus {
    has_pending_deletion: boolean;
    deletion_scheduled_for: string | null;
    requested_at: string | null;
    can_cancel: boolean;
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

const ACCOUNT_DELETION_QUERY_KEY = ['account', 'deletion-status'];

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

export function useAccountDeletionStatus(options?: { enabled?: boolean }) {
    return useQuery<AccountDeletionStatus>({
        queryKey: ACCOUNT_DELETION_QUERY_KEY,
        queryFn: async () => {
            const headers = await getAuthHeaders();
            
            const response = await fetch(`${API_URL}/account/deletion-status`, {
                headers,
            });

            if (!response.ok) {
                return {
                    has_pending_deletion: false,
                    deletion_scheduled_for: null,
                    requested_at: null,
                    can_cancel: false
                };
            }

            return response.json();
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

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to request account deletion');
            }

            return response.json() as Promise<RequestDeletionResponse>;
        },
        onSuccess: (data) => {
            queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
                has_pending_deletion: true,
                deletion_scheduled_for: data.deletion_scheduled_for,
                requested_at: new Date().toISOString(),
                can_cancel: data.can_cancel
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

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to cancel account deletion');
            }

            return response.json() as Promise<CancelDeletionResponse>;
        },
        onSuccess: () => {
            queryClient.setQueryData<AccountDeletionStatus>(ACCOUNT_DELETION_QUERY_KEY, {
                has_pending_deletion: false,
                deletion_scheduled_for: null,
                requested_at: null,
                can_cancel: false
            });
        },
    });
}

