'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface LegacyMigration {
  migration_id: string;
  sandbox_id: string;
  status: 'planned' | 'running' | 'completed' | 'failed' | string;
  phase: 'extract' | 'repo' | 'push' | 'db' | 'done' | string | null;
  step: number | null;
  total_steps: number;
  project_id: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string | null;
}

export interface LegacyMachine {
  sandbox_id: string;
  name: string;
  status: string;
  provider: string;
  created_at: string;
  migratable: boolean;
  migration: LegacyMigration | null;
}

export interface LegacyEligibility {
  eligible: boolean;
  sandboxes: LegacyMachine[];
}

const ELIGIBILITY_KEY = ['legacy-machines'] as const;

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }): T {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Legacy migration request failed');
  }
  return response.data;
}

function isInFlight(machine: LegacyMachine): boolean {
  const s = machine.migration?.status;
  return s === 'running' || s === 'planned';
}

export function useLegacyMachines(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ELIGIBILITY_KEY,
    queryFn: async () =>
      unwrap(await backendApi.get<LegacyEligibility>('/projects/legacy-migration/eligibility')),
    enabled: opts?.enabled ?? true,
    staleTime: 15_000,
    refetchInterval: (query) => {
      const data = query.state.data as LegacyEligibility | undefined;
      return data?.sandboxes?.some(isInFlight) ? 2500 : false;
    },
  });
}

export function useStartLegacyMigration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sandboxId: string) =>
      unwrap(
        await backendApi.post<{ created: boolean; migration: LegacyMigration }>(
          '/projects/legacy-migration/start',
          { sandbox_id: sandboxId },
        ),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ELIGIBILITY_KEY });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
