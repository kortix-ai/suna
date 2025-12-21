import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apifyApprovalsApi, ApifyApproval, ApifyApprovalRequest } from '@/api/apify-approvals';

export type { ApifyApproval, ApifyApprovalRequest };

export function useRequestApifyApproval(threadId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: ApifyApprovalRequest) => {
      return await apifyApprovalsApi.requestApproval(request, threadId);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['apify-approval', data.approval_id] });
    },
    onError: (error: Error) => {
      console.error('Failed to create approval request:', error);
    },
  });
}

export function useApproveApifyRequest(threadId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (approvalId: string) => {
      return await apifyApprovalsApi.approveRequest(approvalId, threadId);
    },
    onSuccess: (data) => {
      // Update the cache immediately with the new data
      queryClient.setQueryData(['apify-approval', data.approval_id], data);
      // Also invalidate to ensure any other queries refetch
      queryClient.invalidateQueries({ queryKey: ['apify-approval', data.approval_id] });
    },
    onError: (error: Error) => {
      console.error('Failed to approve request:', error);
    },
  });
}

export function useGetApifyApprovalStatus(approvalId: string | null, threadId: string) {
  return useQuery({
    queryKey: ['apify-approval', approvalId],
    queryFn: async () => {
      if (!approvalId) return null;
      return await apifyApprovalsApi.getApprovalStatus(approvalId, threadId);
    },
    enabled: !!approvalId,
    refetchInterval: (query) => {
      // Poll if pending
      const data = query.state.data;
      return data?.status === 'pending' ? 5000 : false;
    },
  });
}

