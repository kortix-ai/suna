import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

interface OpsOverview {
  generated_at: string;
  api: {
    status: string;
    env: string;
    tunnel: Record<string, unknown>;
  };
  totals: {
    accounts: number;
    projects: number;
    active_legacy_sandboxes: number;
  };
  sessions: {
    by_status: Record<string, number>;
    errored: number;
  };
  sandboxes: {
    by_status: Record<string, number>;
    by_provider: Record<string, number>;
    errored: number;
  };
  audit: {
    events_24h: number;
    recent: Array<{
      event_id: string;
      account_id: string | null;
      actor_user_id: string | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      occurred_at: string;
    }>;
  };
  usage: {
    last_24h_by_provider: Array<{
      provider: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cost_usd: number;
    }>;
    calls_24h: number;
    cost_usd_24h: number;
  };
  observability: {
    managed_logs_configured: boolean;
    managed_log_host: string | null;
    error_tracking_configured: boolean;
    trace_headers_enabled: boolean;
    otlp_exporter_configured: boolean;
  };
  migrations: {
    by_status: Record<string, number>;
    active_legacy_sandboxes: number;
  };
}

export function useOpsOverview() {
  return useQuery<OpsOverview>({
    queryKey: ['admin', 'ops', 'overview'],
    queryFn: async () => {
      const response = await backendApi.get<OpsOverview>('/ops/overview');
      if (response.error) throw new Error(response.error.message);
      return response.data!;
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}
