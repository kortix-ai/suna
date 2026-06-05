'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';

export interface SunaMigration {
  migration_id: string;
  status: 'planned' | 'running' | 'completed' | 'failed' | string;
  phase: 'extract' | 'repo' | 'push' | 'db' | 'done' | string | null;
  step: number | null;
  total_steps: number;
  project_id: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string | null;
}

export interface SunaEligibility {
  eligible: boolean;
  migration: SunaMigration | null;
}

const KEY = ['suna-migration'] as const;
const keyFor = (accountId?: string | null) => [...KEY, accountId ?? null] as const;

function unwrap<T>(r: { data?: T; success: boolean; error?: Error }): T {
  if (!r.success || r.data === undefined) throw r.error ?? new Error('Suna migration request failed');
  return r.data;
}

const inFlight = (m: SunaMigration | null) => m?.status === 'running' || m?.status === 'planned';

export function useSunaMigration(accountId?: string | null) {
  return useQuery({
    queryKey: keyFor(accountId),
    queryFn: async () => {
      const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
      return unwrap(await backendApi.get<SunaEligibility>(`/projects/suna-migration/eligibility${qs}`));
    },
    staleTime: 15_000,
    refetchInterval: (query) => (inFlight((query.state.data as SunaEligibility | undefined)?.migration ?? null) ? 2500 : false),
  });
}

const DEFAULT_LIMIT = 25;

export function useStartSunaMigration(accountId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (opts?: { limit?: number; offset?: number }) =>
      unwrap(await backendApi.post<{ created: boolean; migration: SunaMigration }>(
        '/projects/suna-migration/start',
        { account_id: accountId ?? undefined, limit: opts?.limit ?? DEFAULT_LIMIT, offset: opts?.offset ?? 0 },
      )),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
