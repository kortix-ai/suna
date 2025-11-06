import { useQuery } from '@tanstack/react-query';
import { apiClient, backendApi } from '@/lib/api-client';

interface UpcomingRun {
  trigger_id: string;
  trigger_name: string;
  trigger_type: string;
  next_run_time: string;
  next_run_time_local: string;
  timezone: string;
  cron_expression: string;
  agent_prompt?: string;
  is_active: boolean;
  human_readable: string;
}

interface UpcomingRunsResponse {
  upcoming_runs: UpcomingRun[];
  total_count: number;
}

export const useAgentUpcomingRuns = (agentId: string, limit: number = 10) => {
  return useQuery({
    queryKey: ['agent-upcoming-runs', agentId, limit],
    queryFn: async (): Promise<UpcomingRunsResponse> => {
      const response = await backendApi.get(`/triggers/agents/${agentId}/upcoming-runs?limit=${limit}`);
      return response.data;
    },
    enabled: !!agentId,
    refetchInterval: 60000,
    staleTime: 30000,
  });
};

export type { UpcomingRun, UpcomingRunsResponse }; 