import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';

export interface ApifyApprovalRequest {
  actor_id: string;
  run_input: Record<string, any>;
  max_cost_usd?: number;
}

export interface ApifyApproval {
  approval_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  actor_id: string;
  estimated_cost_usd?: number;
  estimated_cost_credits?: number;
  max_cost_usd?: number;
  actual_cost_usd?: number;
  actual_cost_credits?: number;
  run_id?: string;
  created_at?: string;
  approved_at?: string;
  expires_at?: string;
  message?: string;
}

export interface ApifyApprovalResponse {
  success: boolean;
  data: ApifyApproval;
}

export function useApproveApifyRequest(threadId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (approvalId: string) => {
      const response = await backendApi.post<ApifyApprovalResponse>(
        `/apify/approvals/${approvalId}/approve`,
        { thread_id: threadId }
      );

      if (!response.success || !response.data?.success) {
        throw new Error(response.data?.data?.message || 'Failed to approve request');
      }

      return response.data.data;
    },
    onSuccess: (data) => {
      // Update the cache immediately with the new data
      queryClient.setQueryData(['apify-approval', data.approval_id], data);
      // Also invalidate to ensure any other queries refetch
      queryClient.invalidateQueries({ queryKey: ['apify-approval', data.approval_id] });
      toast.success('Approval request approved');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to approve request');
    },
  });
}

export function useGetApifyApprovalStatus(approvalId: string | null, threadId: string) {
  return useQuery({
    queryKey: ['apify-approval', approvalId],
    queryFn: async () => {
      if (!approvalId) return null;

      const response = await backendApi.get<ApifyApprovalResponse>(
        `/apify/approvals/${approvalId}?thread_id=${threadId}`
      );

      if (!response.success || !response.data?.success) {
        throw new Error(response.data?.data?.message || 'Failed to get approval status');
      }

      return response.data.data;
    },
    enabled: !!approvalId,
    staleTime: 3000, // Prevent rapid refetches
    refetchInterval: (query) => {
      // Poll every 5s only if pending
      const data = query.state.data;
      return data?.status === 'pending' ? 5000 : false;
    },
  });
}

