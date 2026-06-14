'use client';

import { useAuth } from '@/features/providers/auth-provider';
import { authenticatedFetch } from '@/lib/auth-token';
import { getEnv } from '@/lib/env-config';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface LegacyThread {
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

interface LegacyMessage {
  message_id: string;
  thread_id: string;
  type: string;
  is_llm_message: boolean;
  content: unknown;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface MigrationResult {
  sessionId: string;
  messagesImported: number;
  partsImported: number;
}

function getApiUrl(): string {
  const backendUrl = getEnv().BACKEND_URL;
  return backendUrl || 'http://localhost:8008/v1';
}

async function legacyFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await authenticatedFetch(`${getApiUrl()}/legacy${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Legacy API error ${res.status}`);
  }

  return res.json();
}

export function useLegacyThreads(limit = 50, offset = 0) {
  const { user, isLoading: isAuthLoading } = useAuth();
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

export function useLegacyMessages(threadId: string | null) {
  const { user, isLoading: isAuthLoading } = useAuth();
  return useQuery({
    queryKey: ['legacy-messages', threadId, user?.id ?? 'anonymous'],
    queryFn: () => legacyFetch<{ messages: LegacyMessage[] }>(`/threads/${threadId}/messages`),
    enabled: !isAuthLoading && !!user && !!threadId,
  });
}

export function useMigrateLegacyThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      threadId,
      sandboxExternalId,
    }: {
      threadId: string;
      sandboxExternalId: string;
    }) =>
      legacyFetch<MigrationResult>(`/threads/${threadId}/migrate`, {
        method: 'POST',
        body: JSON.stringify({ sandboxExternalId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['legacy-threads'] });
      queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions'] });
    },
  });
}

interface MigrateAllStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  total: number;
  completed: number;
  failed: number;
  errors: string[];
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
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: ['legacy-migrate-all-status', user?.id ?? 'anonymous'],
    queryFn: () => legacyFetch<MigrateAllStatus>(`/migrate-all/status`),
    enabled: enabled && !isAuthLoading && !!user,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'running') return 2000;
      // When done, refresh threads and sessions
      if (data?.status === 'done') {
        queryClient.invalidateQueries({ queryKey: ['legacy-threads'] });
        queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions'] });
      }
      return false;
    },
  });
}

export type { LegacyMessage, LegacyThread, MigrateAllStatus, MigrationResult };
