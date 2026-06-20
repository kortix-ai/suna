import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface PoolHealth {
  status: 'healthy' | 'warning' | 'critical' | 'disabled';
  service_running: boolean;
  pool_enabled: boolean;
  pool_size: number;
  min_size: number;
  replenish_threshold: number;
  issues: string[];
}

export interface PoolConfig {
  enabled: boolean;
  min_size: number;
  max_size: number;
  replenish_threshold: number;
  check_interval: number;
  max_age: number;
}

export interface PoolStats {
  pool_size: number;
  total_created: number;
  total_claimed: number;
  total_expired: number;
  avg_claim_time_ms: number;
  pool_hit_rate: number;
  last_replenish_at: string | null;
  last_cleanup_at: string | null;
  config: PoolConfig;
}

export interface PooledSandbox {
  id: string;
  external_id: string;
  provider: string;
  status: string;
  server_type?: string | null;
  location?: string | null;
  pooled_at: string | null;
  created_at: string | null;
}

export interface PooledSandboxList {
  count: number;
  sandboxes: PooledSandbox[];
}

export interface ReplenishResponse {
  success: boolean;
  sandboxes_created: number;
  pool_size_before: number;
  pool_size_after: number;
}

export interface ForceCreateResponse {
  success: boolean;
  requested: number;
  created_count: number;
  created_ids: string[];
  failed_count: number;
  failed_errors: string[];
  pool_size_before: number;
  pool_size_after: number;
}

export interface CleanupResponse {
  success: boolean;
  cleaned_count: number;
  pool_size_before: number;
  pool_size_after: number;
}

export interface RestartResponse {
  success: boolean;
  was_running: boolean;
  is_running: boolean;
  message: string;
}

export interface RemoveResponse {
  success: boolean;
  removed_count: number;
  removed_ids: string[];
  failed_count: number;
  failed: Array<{ id: string; error: string }>;
}

export interface PoolResource {
  id: string;
  provider: string;
  serverType: string;
  location: string;
  desiredCount: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const QUERY_KEYS = {
  health: ['admin-sandbox-pool-health'],
  stats: ['admin-sandbox-pool-stats'],
  list: ['admin-sandbox-pool-list'],
  resources: ['admin-sandbox-pool-resources'],
};

export const useSandboxPoolHealth = () => {
  return useQuery<PoolHealth>({
    queryKey: QUERY_KEYS.health,
    queryFn: async () => {
      const response = await backendApi.get<PoolHealth>('/admin/sandbox-pool/health');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 5 * 1000,
    refetchInterval: 10 * 1000,
  });
};

export const useSandboxPoolStats = () => {
  return useQuery<PoolStats>({
    queryKey: QUERY_KEYS.stats,
    queryFn: async () => {
      const response = await backendApi.get<PoolStats>('/admin/sandbox-pool/stats');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 5 * 1000,
    refetchInterval: 10 * 1000,
  });
};

export const useSandboxPoolList = (limit: number = 50) => {
  return useQuery<PooledSandboxList>({
    queryKey: [...QUERY_KEYS.list, limit],
    queryFn: async () => {
      const response = await backendApi.get<PooledSandboxList>(`/admin/sandbox-pool/list?limit=${limit}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
};

export const useSandboxPoolReplenish = () => {
  const queryClient = useQueryClient();

  return useMutation<ReplenishResponse>({
    mutationFn: async () => {
      const response = await backendApi.post<ReplenishResponse>('/admin/sandbox-pool/replenish');
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list });
    },
  });
};

export const useSandboxPoolForceCreate = () => {
  const queryClient = useQueryClient();

  return useMutation<ForceCreateResponse, Error, { count: number; resource_id?: string }>({
    mutationFn: async ({ count, resource_id }) => {
      const response = await backendApi.post<ForceCreateResponse>('/admin/sandbox-pool/force-create', { count, resource_id });
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list });
    },
  });
};

export const useSandboxPoolCleanup = () => {
  const queryClient = useQueryClient();

  return useMutation<CleanupResponse>({
    mutationFn: async () => {
      const response = await backendApi.post<CleanupResponse>('/admin/sandbox-pool/cleanup');
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list });
    },
  });
};

export const useSandboxPoolRestart = () => {
  const queryClient = useQueryClient();

  return useMutation<RestartResponse>({
    mutationFn: async () => {
      const response = await backendApi.post<RestartResponse>('/admin/sandbox-pool/restart-service');
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
    },
  });
};

export const usePoolResources = () => {
  return useQuery<{ resources: PoolResource[] }>({
    queryKey: QUERY_KEYS.resources,
    queryFn: async () => {
      const response = await backendApi.get<{ resources: PoolResource[] }>('/admin/sandbox-pool/resources');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 10 * 1000,
  });
};

export const useCreatePoolResource = () => {
  const queryClient = useQueryClient();
  return useMutation<{ resource: PoolResource }, Error, { provider: string; server_type: string; location: string; desired_count: number }>({
    mutationFn: async (data) => {
      const response = await backendApi.post<{ resource: PoolResource }>('/admin/sandbox-pool/resources', data);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
    },
  });
};

export const useUpdatePoolResource = () => {
  const queryClient = useQueryClient();
  return useMutation<{ resource: PoolResource }, Error, { id: string; desired_count?: number; enabled?: boolean }>({
    mutationFn: async ({ id, ...data }) => {
      const response = await backendApi.patch<{ resource: PoolResource }>(`/admin/sandbox-pool/resources/${id}`, data);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
    },
  });
};

export const useDeletePoolResource = () => {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: async (id) => {
      const response = await backendApi.delete<{ success: boolean }>(`/admin/sandbox-pool/resources/${id}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
    },
  });
};

export const useSandboxPoolRemove = () => {
  const queryClient = useQueryClient();

  return useMutation<RemoveResponse, Error, { sandbox_ids: string[]; delete_sandbox?: boolean }>({
    mutationFn: async (data) => {
      const response = await backendApi.post<RemoveResponse>('/admin/sandbox-pool/remove', data);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.list });
    },
  });
};
