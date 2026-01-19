import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface StatelessHealth {
  healthy: boolean;
  ready: boolean;
  initialized: boolean;
  shutting_down: boolean;
  flusher: {
    runs: number;
    pending: number;
    running: boolean;
  };
  ownership: {
    worker_id: string;
    owned: number;
    running: boolean;
    run_ids: string[];
  };
  recovery: {
    running: boolean;
    callbacks: number;
    sharded: boolean;
    shard_id: number | null;
    total_shards: number | null;
  };
}

export interface StatelessDashboard {
  active_runs: number;
  owned_runs: number;
  pending_writes: number;
  stuck_count: number;
  runs_started: number;
  runs_completed: number;
  runs_failed: number;
  runs_recovered: number;
  runs_rejected: number;
  flush_latency_avg: number;
  flush_latency_p99: number;
  wal: {
    total_pending: number;
    runs_with_pending: number;
    local_buffer_runs: number;
  };
  dlq: {
    total_entries: number;
    unique_runs: number;
    by_type: Record<string, number>;
    oldest_entry_age: number;
  };
  healthy: boolean;
  alerts: Array<{
    level: string;
    metric: string;
    value: number;
  }>;
}

export interface StuckRun {
  run_id: string;
  owner: string | null;
  status: string | null;
  heartbeat: number | null;
  heartbeat_age: number | null;
  start: number | null;
  duration: number | null;
  reason: string | null;
}

export interface DLQEntry {
  entry_id: string;
  run_id: string;
  write_type: string;
  error: string;
  attempt_count: number;
  created_at: number;
  failed_at: number;
}

export interface RecoveryResponse {
  run_id: string;
  success: boolean;
  action: string;
  message: string;
  error: string | null;
}

export interface CircuitBreaker {
  name: string;
  state: 'closed' | 'open' | 'half_open';
  stats: {
    total_calls: number;
    successful_calls: number;
    failed_calls: number;
    rejected_calls: number;
    consecutive_failures: number;
    consecutive_successes: number;
  };
  opened_at: number | null;
  retry_after: number | null;
}

export interface Backpressure {
  level: 'normal' | 'elevated' | 'high' | 'critical';
  pending_writes: number;
  active_runs: number;
  flush_latency_ms: number;
  memory_percent: number;
  should_accept_work: boolean;
  should_shed_load: boolean;
  recommended_batch_size: number;
  recommended_flush_interval: number;
}

export interface SweepResult {
  orphaned: number;
  recovered: number;
  stuck: number;
  completed: number;
  errors: string[];
}

export interface FlushResult {
  runs: number;
  total: number;
  details: Record<string, number>;
}

const QUERY_KEYS = {
  health: ['admin-stateless-health'],
  dashboard: ['admin-stateless-dashboard'],
  stuck: ['admin-stateless-stuck'],
  dlq: ['admin-stateless-dlq'],
  wal: ['admin-stateless-wal'],
  circuitBreakers: ['admin-stateless-circuit-breakers'],
  backpressure: ['admin-stateless-backpressure'],
  rateLimiters: ['admin-stateless-rate-limiters'],
};

export const useStatelessHealth = () => {
  return useQuery<StatelessHealth>({
    queryKey: QUERY_KEYS.health,
    queryFn: async () => {
      const response = await backendApi.get<StatelessHealth>('/admin/stateless/health');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 5 * 1000,
    refetchInterval: 10 * 1000,
  });
};

export const useStatelessDashboard = () => {
  return useQuery<StatelessDashboard>({
    queryKey: QUERY_KEYS.dashboard,
    queryFn: async () => {
      const response = await backendApi.get<StatelessDashboard>('/admin/stateless/dashboard');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 5 * 1000,
    refetchInterval: 10 * 1000,
  });
};

export const useStatelessStuckRuns = (minAge: number = 5) => {
  return useQuery<StuckRun[]>({
    queryKey: [...QUERY_KEYS.stuck, minAge],
    queryFn: async () => {
      const response = await backendApi.get<StuckRun[]>(`/admin/stateless/stuck?min_age=${minAge}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
};

export const useStatelessDLQ = (count: number = 50, runId?: string) => {
  return useQuery<DLQEntry[]>({
    queryKey: [...QUERY_KEYS.dlq, count, runId],
    queryFn: async () => {
      let url = `/admin/stateless/dlq/entries?count=${count}`;
      if (runId) url += `&run_id=${runId}`;
      const response = await backendApi.get<DLQEntry[]>(url);
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
};

export const useStatelessWALStats = () => {
  return useQuery<{ total_pending: number; runs_with_pending: number; local_buffer_runs: number }>({
    queryKey: QUERY_KEYS.wal,
    queryFn: async () => {
      const response = await backendApi.get('/admin/stateless/wal/stats');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });
};

export const useStatelessCircuitBreakers = () => {
  return useQuery<Record<string, CircuitBreaker>>({
    queryKey: QUERY_KEYS.circuitBreakers,
    queryFn: async () => {
      const response = await backendApi.get<Record<string, CircuitBreaker>>('/admin/stateless/circuit-breakers');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 5 * 1000,
    refetchInterval: 10 * 1000,
  });
};

export const useStatelessBackpressure = () => {
  return useQuery<Backpressure>({
    queryKey: QUERY_KEYS.backpressure,
    queryFn: async () => {
      const response = await backendApi.get<Backpressure>('/admin/stateless/backpressure');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 5 * 1000,
    refetchInterval: 10 * 1000,
  });
};

export interface RateLimiterStats {
  type: string;
  tokens?: number;
  capacity?: number;
  rate?: number;
  requests_in_window?: number;
  max_requests?: number;
  window_seconds?: number;
  current_rate?: number;
  min_rate?: number;
  max_rate?: number;
  success_count?: number;
  failure_count?: number;
}

export const useStatelessRateLimiters = () => {
  return useQuery<Record<string, RateLimiterStats>>({
    queryKey: QUERY_KEYS.rateLimiters,
    queryFn: async () => {
      const response = await backendApi.get<Record<string, RateLimiterStats>>('/admin/stateless/rate-limiters');
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 5 * 1000,
    refetchInterval: 10 * 1000,
  });
};

export interface RunInfo {
  run_id: string;
  owner: string | null;
  status: string | null;
  heartbeat: number | null;
  heartbeat_age: number | null;
  start: number | null;
  duration: number | null;
  pending_writes: number;
  wal_entries: number;
}

export const useStatelessRunLookup = (runId: string | null) => {
  return useQuery<RunInfo>({
    queryKey: ['admin-stateless-run', runId],
    queryFn: async () => {
      if (!runId) throw new Error('No run ID');
      const response = await backendApi.get<RunInfo>(`/admin/stateless/run/${runId}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    enabled: !!runId && runId.length >= 8,
    staleTime: 5 * 1000,
    retry: false,
  });
};

export interface MetricsSnapshot {
  timestamp: number;
  active_runs: number;
  pending_writes: number;
  runs_started: number;
  runs_completed: number;
  runs_failed: number;
  flush_latency_avg: number;
  flush_latency_p99: number;
  writes_dropped: number;
  dlq_entries: number;
}

export interface MetricsHistory {
  current: MetricsSnapshot;
  history: MetricsSnapshot[];
  minutes: number;
}

export const useStatelessMetricsHistory = (minutes: number = 30) => {
  return useQuery<MetricsHistory>({
    queryKey: ['admin-stateless-metrics-history', minutes],
    queryFn: async () => {
      const response = await backendApi.get<MetricsHistory>(`/admin/stateless/metrics/history?minutes=${minutes}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    staleTime: 10 * 1000,
    refetchInterval: 15 * 1000, // Poll every 15s to build history
  });
};

export const useStatelessSweep = () => {
  const queryClient = useQueryClient();

  return useMutation<SweepResult>({
    mutationFn: async () => {
      const response = await backendApi.post<SweepResult>('/admin/stateless/sweep');
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stuck });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.health });
    },
  });
};

export const useStatelessFlush = () => {
  const queryClient = useQueryClient();

  return useMutation<FlushResult>({
    mutationFn: async () => {
      const response = await backendApi.post<FlushResult>('/admin/stateless/flush');
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wal });
    },
  });
};

export const useStatelessForceResume = () => {
  const queryClient = useQueryClient();

  return useMutation<RecoveryResponse, Error, string>({
    mutationFn: async (runId: string) => {
      const response = await backendApi.post<RecoveryResponse>(`/admin/stateless/resume/${runId}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stuck });
    },
  });
};

export const useStatelessForceComplete = () => {
  const queryClient = useQueryClient();

  return useMutation<RecoveryResponse, Error, { runId: string; reason?: string }>({
    mutationFn: async ({ runId, reason = 'admin' }) => {
      const response = await backendApi.post<RecoveryResponse>(`/admin/stateless/complete/${runId}?reason=${reason}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stuck });
    },
  });
};

export const useStatelessForceFail = () => {
  const queryClient = useQueryClient();

  return useMutation<RecoveryResponse, Error, { runId: string; error: string }>({
    mutationFn: async ({ runId, error }) => {
      const response = await backendApi.post<RecoveryResponse>(`/admin/stateless/fail/${runId}`, { error });
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stuck });
    },
  });
};

export const useStatelessDLQRetry = () => {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; entry_id: string }, Error, string>({
    mutationFn: async (entryId: string) => {
      const response = await backendApi.post(`/admin/stateless/dlq/retry/${entryId}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dlq });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
    },
  });
};

export const useStatelessDLQDelete = () => {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; entry_id: string }, Error, string>({
    mutationFn: async (entryId: string) => {
      const response = await backendApi.delete(`/admin/stateless/dlq/${entryId}`);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dlq });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
    },
  });
};

export const useStatelessDLQPurge = () => {
  const queryClient = useQueryClient();

  return useMutation<{ deleted: number }, Error, number | undefined>({
    mutationFn: async (olderThanHours?: number) => {
      let url = '/admin/stateless/dlq/purge';
      if (olderThanHours) url += `?older_than_hours=${olderThanHours}`;
      const response = await backendApi.post(url);
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dlq });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
    },
  });
};

export const useStatelessResetCircuitBreakers = () => {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean }>({
    mutationFn: async () => {
      const response = await backendApi.post('/admin/stateless/circuit-breakers/reset');
      if (response.error) throw response.error;
      return response.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.circuitBreakers });
    },
  });
};
