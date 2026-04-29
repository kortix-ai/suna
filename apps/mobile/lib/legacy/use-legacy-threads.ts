/**
 * Legacy threads hooks — ported from apps/web/src/hooks/legacy/use-legacy-threads.ts
 *
 * Lists pre-OpenCode chats and bulk-converts them into sessions via the
 * platform backend's /v1/legacy endpoints.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useAuthContext } from '@/contexts';

export interface LegacyThread {
  thread_id: string;
  account_id: string;
  project_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
  user_message_count: number;
  total_message_count: number;
  migrated_session_id: string | null;
}

export interface MigrateAllStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  total: number;
  completed: number;
  failed: number;
  errors: string[];
}

async function legacyFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_URL}/legacy${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error || `Legacy API error ${res.status}`);
  }
  return res.json();
}

export function useLegacyThreads(limit = 50, offset = 0) {
  const { user, isLoading: isAuthLoading } = useAuthContext();
  return useQuery({
    queryKey: ['legacy-threads', limit, offset, user?.id ?? 'anonymous'],
    queryFn: () =>
      legacyFetch<{ threads: LegacyThread[]; total: number }>(
        `/threads?limit=${limit}&offset=${offset}`,
      ),
    enabled: !isAuthLoading && !!user,
    staleTime: 60_000,
  });
}

export function useMigrateAllLegacyThreads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sandboxExternalId }: { sandboxExternalId: string }) =>
      legacyFetch<MigrateAllStatus>(`/migrate-all`, {
        method: 'POST',
        body: JSON.stringify({ sandboxExternalId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['legacy-threads'] });
      queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions'] });
    },
  });
}

export function useMigrateAllStatus(enabled: boolean) {
  const queryClient = useQueryClient();
  const { user, isLoading: isAuthLoading } = useAuthContext();
  return useQuery({
    queryKey: ['legacy-migrate-all-status', user?.id ?? 'anonymous'],
    queryFn: () => legacyFetch<MigrateAllStatus>(`/migrate-all/status`),
    enabled: enabled && !isAuthLoading && !!user,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'running') return 2000;
      if (data?.status === 'done') {
        queryClient.invalidateQueries({ queryKey: ['legacy-threads'] });
        queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions'] });
      }
      return false;
    },
  });
}
