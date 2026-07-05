/**
 * Kortix workspace compatibility hooks.
 *
 * Fetches from kortix-master's legacy /kortix/projects API through the currently
 * active sandbox route (/v1/p/.../8000/kortix/projects). This keeps Kortix
 * workspace data on the same authenticated transport path as the rest of the
 * dashboard/OpenCode APIs.
 */

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import { useAuth } from '@/features/providers/auth-provider';
import {
  listKortixProjects,
  getKortixProject,
  getKortixProjectBySession,
  listKortixProjectSessions,
  deleteKortixProject,
  patchKortixProject,
} from '@kortix/sdk/opencode-client';
import type { KortixProject } from '@kortix/sdk/opencode-client';

// ── Types ────────────────────────────────────────────────────────────────────
// The request/response shape lives in the SDK now (`@kortix/sdk/opencode-client`);
// re-exported here for existing importers.

export type { KortixProject };

// ── Query keys ───────────────────────────────────────────────────────────────

export const kortixKeys = {
  projects: () => ['kortix', 'projects'] as const,
  project: (id: string) => ['kortix', 'projects', id] as const,
};

interface KortixProjectQueryOptions {
  enabled?: boolean;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useKortixProjects(_args?: undefined, options: KortixProjectQueryOptions = {}) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject[]>({
    queryKey: [...kortixKeys.projects(), user?.id ?? 'anonymous', serverUrl],
    queryFn: () => listKortixProjects(serverUrl),
    enabled: !isAuthLoading && !!user && !!serverUrl && (options.enabled ?? true),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  });
}

export function useKortixProject(id: string) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject>({
    queryKey: [...kortixKeys.project(id), user?.id ?? 'anonymous', serverUrl],
    queryFn: () => getKortixProject(serverUrl, id),
    enabled: !isAuthLoading && !!user && !!serverUrl && !!id,
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
    retry: 2,
    // Keep previous data while a new query (e.g. from a runtime URL change)
    // is loading. Prevents the skeleton flash.
    placeholderData: keepPreviousData,
  });
}

export function useKortixProjectForSession(sessionId: string, options: KortixProjectQueryOptions = {}) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<KortixProject | null>({
    queryKey: ['kortix', 'projects', 'by-session', sessionId, user?.id ?? 'anonymous', serverUrl],
    queryFn: async () => {
      try {
        return await getKortixProjectBySession(serverUrl, sessionId);
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
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<any[]>({
    queryKey: ['kortix', 'projects', projectId, 'sessions', user?.id ?? 'anonymous', serverUrl],
    queryFn: () => listKortixProjectSessions(serverUrl, projectId),
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
    mutationFn: (id: string) => deleteKortixProject(serverUrl, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: kortixKeys.projects() });
    },
  });
}

export function usePatchProject() {
  const qc = useQueryClient();
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string; user_handle?: string | null }) =>
      patchKortixProject(serverUrl, id, body),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: kortixKeys.project(vars.id) });
      qc.invalidateQueries({ queryKey: kortixKeys.projects() });
    },
  });
}
