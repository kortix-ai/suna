/**
 * Kortix Projects hooks.
 *
 * Fetches from kortix-master's /kortix/projects API through the currently
 * active sandbox route (/v1/p/.../8000/kortix/projects). This keeps Kortix
 * workspace data on the same authenticated transport path as the rest of the
 * dashboard/OpenCode APIs.
 */

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { useAuth } from '@/components/AuthProvider';

// ── Types ────────────────────────────────────────────────────────────────────

export interface KortixProject {
  id: string;
  name: string;
  path: string;
  description: string;
  created_at: string;
  opencode_id: string | null;
  sessionCount?: number;
  // Extended properties from OpenCode Project (optional for compatibility)
  worktree?: string;
  time?: {
    created: number;
    updated: number;
    initialized?: number;
  };
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

async function kortixFetch<T>(serverUrl: string, apiPath: string, init?: RequestInit): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, '')}/kortix/projects${apiPath}`;
  const res = await authenticatedFetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kortix API ${res.status}: ${text.slice(0, 100)}`);
  }
  return res.json();
}

// ── Query keys ───────────────────────────────────────────────────────────────

export const kortixKeys = {
  projects: () => ['kortix', 'projects'] as const,
  project: (id: string) => ['kortix', 'projects', id] as const,
};

interface KortixProjectQueryOptions {
  enabled?: boolean;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useKortixProjects() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverVersion = useServerStore((s) => s.serverVersion);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject[]>({
    queryKey: [...kortixKeys.projects(), user?.id ?? 'anonymous', serverUrl, serverVersion],
    queryFn: () => kortixFetch<KortixProject[]>(serverUrl, ''),
    enabled: !isAuthLoading && !!user && !!serverUrl,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  });
}

export function useKortixProject(id: string) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverVersion = useServerStore((s) => s.serverVersion);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject>({
    queryKey: [...kortixKeys.project(id), user?.id ?? 'anonymous', serverUrl, serverVersion],
    queryFn: () => kortixFetch<KortixProject>(serverUrl, `/${encodeURIComponent(id)}`),
    enabled: !isAuthLoading && !!user && !!serverUrl && !!id,
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
    retry: 2,
    // Keep previous data while a new query (e.g. from a serverVersion bump
    // when another tab closes) is loading. Prevents the skeleton flash.
    placeholderData: keepPreviousData,
  });
}

export function useKortixProjectForSession(sessionId: string, options: KortixProjectQueryOptions = {}) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverVersion = useServerStore((s) => s.serverVersion);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject | null>({
    queryKey: ['kortix', 'projects', 'by-session', sessionId, user?.id ?? 'anonymous', serverUrl, serverVersion],
    queryFn: async () => {
      try {
        return await kortixFetch<KortixProject>(serverUrl, `/by-session/${encodeURIComponent(sessionId)}`);
      } catch {
        return null;
      }
    },
    enabled: !isAuthLoading && !!user && !!serverUrl && !!sessionId && (options.enabled ?? true),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch sessions linked to a specific project.
 * Returns OpenCode session objects enriched with title, time, etc.
 */
export function useKortixProjectSessions(
  projectId: string,
  options: KortixProjectQueryOptions = {},
) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverVersion = useServerStore((s) => s.serverVersion);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<any[]>({
    queryKey: ['kortix', 'projects', projectId, 'sessions', user?.id ?? 'anonymous', serverUrl, serverVersion],
    queryFn: () => kortixFetch<any[]>(serverUrl, `/${encodeURIComponent(projectId)}/sessions`),
    enabled: !isAuthLoading && !!user && !!serverUrl && !!projectId && (options.enabled ?? true),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 2,
    placeholderData: keepPreviousData,
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: (id: string) =>
      kortixFetch<{ deleted: boolean; name: string; path: string }>(serverUrl, `/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: kortixKeys.projects() });
    },
  });
}

