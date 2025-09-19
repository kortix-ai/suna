import { backendApi } from '@/lib/api-client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface UserSummary {
  id: string;
  email: string;
  created_at: string;
  tier: string;
  credit_balance: number;
  total_purchased: number;
  total_used: number;
  subscription_status?: string;
  last_activity?: string;
  trial_status?: string;
}

interface PaginationMeta {
  current_page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
  next_cursor?: string | null;
  previous_cursor?: string | null;
}

interface UserListResponse {
  data: UserSummary[];
  pagination: PaginationMeta;
}

interface UserListParams {
  page?: number;
  page_size?: number;
  search_email?: string;
  search_name?: string;
  tier_filter?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

interface UserDetails {
  user: {
    id: string;
    created_at: string;
    billing_customers: Array<{ email: string }>;
    credit_accounts: Array<{
      balance: number;
      tier: string;
      lifetime_granted: number;
      lifetime_purchased: number;
      lifetime_used: number;
      last_grant_date?: string;
    }>;
    billing_subscriptions: Array<{
      status: string;
      created: string;
      current_period_end?: string;
    }>;
  };
  recent_activity: Array<{
    id: string;
    created_at: string;
    status: string;
    thread_id: string;
  }>;
}

interface UserStats {
  total_users: number;
  active_users_30d: number;
  tier_distribution: Array<{
    tier: string;
    count: number;
  }>;
}

export function useAdminUserList(params: UserListParams = {}) {
  return useQuery({
    queryKey: ['admin', 'users', 'list', params],
    queryFn: async (): Promise<UserListResponse> => {
      const searchParams = new URLSearchParams();
      
      if (params.page) searchParams.append('page', params.page.toString());
      if (params.page_size) searchParams.append('page_size', params.page_size.toString());
      if (params.search_email) searchParams.append('search_email', params.search_email);
      if (params.search_name) searchParams.append('search_name', params.search_name);
      if (params.tier_filter) searchParams.append('tier_filter', params.tier_filter);
      if (params.sort_by) searchParams.append('sort_by', params.sort_by);
      if (params.sort_order) searchParams.append('sort_order', params.sort_order);
      
      const response = await backendApi.get(`/admin/users/list?${searchParams.toString()}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 30000,
  });
}

export function useAdminUserDetails(userId: string | null) {
  return useQuery({
    queryKey: ['admin', 'users', 'details', userId],
    queryFn: async (): Promise<UserDetails> => {
      if (!userId) throw new Error('User ID is required');
      
      const response = await backendApi.get(`/admin/users/${userId}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    enabled: !!userId,
    staleTime: 60000,
  });
}

interface SearchResponse {
  data: Array<{
    id: string;
    email: string;
    created_at: string;
    tier: string;
    credit_balance: number;
    trial_status?: string;
  }>;
  pagination: PaginationMeta;
}

export function useAdminUserSearch() {
  return useMutation({
    mutationFn: async (email: string): Promise<SearchResponse> => {
      const response = await backendApi.get(`/admin/users/search/email?email=${encodeURIComponent(email)}`);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
}

interface AdvancedSearchParams {
  email_contains?: string;
  tier_in?: string[];
  subscription_status_in?: string[];
  trial_status_in?: string[];
  balance_min?: number;
  balance_max?: number;
  created_after?: string;
  created_before?: string;
  has_activity_since?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

export function useAdminAdvancedSearch() {
  return useMutation({
    mutationFn: async (params: AdvancedSearchParams): Promise<UserListResponse> => {
      const response = await backendApi.post('/admin/users/search/advanced', params);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
}

export function useAdminUserStats() {
  return useQuery({
    queryKey: ['admin', 'users', 'stats'],
    queryFn: async (): Promise<UserStats> => {
      const response = await backendApi.get('/admin/users/stats/overview');
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    staleTime: 300000,
  });
}

export function useRefreshUserData() {
  const queryClient = useQueryClient();
  
  return {
    refreshUserList: (params?: UserListParams) => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'users', 'list'],
      });
    },
    refreshUserDetails: (userId: string) => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'users', 'details', userId],
      });
    },
    refreshUserStats: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'users', 'stats'],
      });
    },
  };
} 