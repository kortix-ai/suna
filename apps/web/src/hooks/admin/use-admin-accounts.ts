import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface AdminAccount {
  accountId: string;
  name: string | null;
  ownerEmail: string | null;
  memberCount: number;
  balance: string | null;
  expiringCredits: string | null;
  nonExpiringCredits: string | null;
  dailyCreditsBalance: string | null;
  tier: string | null;
  paymentStatus: string | null;
  provider: string | null;
  planType: string | null;
  stripeSubscriptionId: string | null;
  billingCustomerId: string | null;
  billingCustomerEmail: string | null;
  createdAt: string | null;
}

export interface AdminAccountsResponse {
  accounts: AdminAccount[];
  total: number;
  page: number;
  limit: number;
  error?: string;
}

export interface AdminAccountUser {
  user_id: string;
  email: string;
  account_role: string;
  created_at: string;
}

export function useAdminAccounts(params: { search?: string; page?: number; limit?: number }) {
  const { search = '', page = 1, limit = 50 } = params;
  return useQuery<AdminAccountsResponse>({
    queryKey: ['admin', 'accounts', search, page, limit],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (search) q.set('search', search);
      q.set('page', String(page));
      q.set('limit', String(limit));
      const response = await backendApi.get<AdminAccountsResponse>(`/admin/api/accounts?${q.toString()}`);
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useAdminAccountUsers(accountId: string | null) {
  return useQuery<{ users: AdminAccountUser[] }>({
    queryKey: ['admin', 'accounts', accountId, 'users'],
    enabled: !!accountId,
    queryFn: async () => {
      const response = await backendApi.get<{ users: AdminAccountUser[] }>(`/admin/api/accounts/${accountId}/users`);
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
  });
}

export function useAdminGrantCredits() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { accountId: string; amount: number; description: string; isExpiring: boolean }>({
    mutationFn: async ({ accountId, amount, description, isExpiring }) => {
      const response = await backendApi.post(`/admin/api/accounts/${accountId}/credits`, { amount, description, isExpiring });
      if (response.error) throw new Error(response.error.message);
      return response.data;
    },
    onSuccess: (_data, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'accounts', accountId, 'users'] });
    },
  });
}
