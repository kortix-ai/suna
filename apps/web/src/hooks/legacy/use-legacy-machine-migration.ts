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

// Legacy machines belong to a single account. Scope every query/mutation to the
// account the projects grid currently has selected so a machine (and its
// post-migration "Migrated → Open" card) only shows on the account it lives on.
function eligibilityKey(accountId?: string | null) {
  return [...ELIGIBILITY_KEY, accountId ?? null] as const;
}

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

export function useLegacyMachines(opts?: { enabled?: boolean; accountId?: string | null }) {
  const accountId = opts?.accountId ?? null;
  return useQuery({
    queryKey: eligibilityKey(accountId),
    queryFn: async () => {
      const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
      return unwrap(
        await backendApi.get<LegacyEligibility>(`/projects/legacy-migration/eligibility${qs}`),
      );
    },
    enabled: opts?.enabled ?? true,
    staleTime: 15_000,
    refetchInterval: (query) => {
      const data = query.state.data as LegacyEligibility | undefined;
      return data?.sandboxes?.some(isInFlight) ? 2500 : false;
    },
  });
}

export function useStartLegacyMigration(accountId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sandboxId: string) =>
      unwrap(
        await backendApi.post<{ created: boolean; migration: LegacyMigration }>(
          '/projects/legacy-migration/start',
          { sandbox_id: sandboxId, account_id: accountId ?? undefined },
        ),
      ),
    onSuccess: () => {
      // Invalidate every account scope — ELIGIBILITY_KEY is a prefix of the
      // per-account key, so this refreshes whichever one is mounted.
      queryClient.invalidateQueries({ queryKey: ELIGIBILITY_KEY });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
