import { backendApi } from '@/lib/api-client';
import { useMutation, useQuery } from '@tanstack/react-query';

interface CreditAdjustmentRequest {
  account_id: string;
  amount: number;
  reason: string;
  is_expiring: boolean;
  notify_user: boolean;
}

interface RefundRequest {
  account_id: string;
  amount: number;
  reason: string;
  is_expiring: boolean;
  stripe_refund: boolean;
  payment_intent_id?: string;
}

interface UserSearchRequest {
  email?: string;
  account_id?: string;
}

interface GrantCreditsRequest {
  account_ids: string[];
  amount: number;
  reason: string;
  is_expiring: boolean;
  notify_users: boolean;
}

export function useSearchUser() {
  return useMutation({
    mutationFn: async (request: UserSearchRequest) => {
      const response = await backendApi.post('/admin/billing/user/search', request);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
}

export function useUserBillingSummary(userId: string | null) {
  return useQuery({
    queryKey: ['admin', 'billing', 'user', userId],
    queryFn: async () => {
      if (!userId) return null;
      const response = await backendApi.get(`/admin/billing/user/${userId}/summary`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    enabled: !!userId,
  });
}

export function useUserTransactions(userId: string | null, limit = 100, offset = 0, typeFilter?: string) {
  return useQuery({
    queryKey: ['admin', 'billing', 'transactions', userId, limit, offset, typeFilter],
    queryFn: async () => {
      if (!userId) return null;
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });
      if (typeFilter) params.append('type_filter', typeFilter);
      
      const response = await backendApi.get(`/admin/billing/user/${userId}/transactions?${params}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    enabled: !!userId,
  });
}

export function useAdjustCredits() {
  return useMutation({
    mutationFn: async (request: CreditAdjustmentRequest) => {
      const response = await backendApi.post('/admin/billing/credits/adjust', request);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
}

export function useProcessRefund() {
  return useMutation({
    mutationFn: async (request: RefundRequest) => {
      const response = await backendApi.post('/admin/billing/refund', request);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
}

export function useGrantBulkCredits() {
  return useMutation({
    mutationFn: async (request: GrantCreditsRequest) => {
      const response = await backendApi.post('/admin/billing/credits/grant-bulk', request);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
}

export function useMigrateUserToCredits() {
  return useMutation({
    mutationFn: async (userId: string) => {
      const response = await backendApi.post(`/admin/billing/migrate-user/${userId}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
} 