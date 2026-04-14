import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';

export interface AccessRequest {
  id: string;
  email: string;
  company: string | null;
  useCase: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

interface AccessRequestsResponse {
  requests: AccessRequest[];
  summary: { pending: number; approved: number; rejected: number };
  limit: number;
  offset: number;
}

export function useAccessRequests(params: { status?: string; limit?: number; offset?: number } = {}) {
  const { user } = useAuth();
  const { status, limit = 50, offset = 0 } = params;

  return useQuery<AccessRequestsResponse>({
    queryKey: ['admin', 'access-requests', status, limit, offset],
    queryFn: async () => {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      query.set('limit', String(limit));
      query.set('offset', String(offset));

      const response = await backendApi.get<AccessRequestsResponse>(
        `/access/requests?${query.toString()}`
      );

      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    enabled: !!user,
    staleTime: 30_000,
  });
}

export function useApproveRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await backendApi.post<{ success: boolean; email: string }>(
        `/access/requests/${id}/approve`
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'access-requests'] });
    },
  });
}

export function useRejectRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await backendApi.post<{ success: boolean; email: string }>(
        `/access/requests/${id}/reject`
      );
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'access-requests'] });
    },
  });
}
