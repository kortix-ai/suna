'use client';

import { useQuery } from '@tanstack/react-query';
import type { Project, Path as PathInfo } from '../../core/runtime/wire-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { useCurrentRuntime } from '../use-current-runtime';

// ============================================================================
// Project Hooks
// ============================================================================

export function useRuntimeProjects() {
  const runtimeReady = useRuntimeReady();
  const projectId = useCurrentRuntime((state) => state.projectId);
  const project = projectId ? { id: projectId, path: '/workspace', worktree: '/workspace' } : null;
  return useQuery<Project[]>({
    queryKey: runtimeKeys.projects(),
    queryFn: async () => project ? [project] : [],
    enabled: runtimeReady && Boolean(projectId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

export function useRuntimeCurrentProject() {
  const runtimeReady = useRuntimeReady();
  const projectId = useCurrentRuntime((state) => state.projectId);
  return useQuery<Project>({
    queryKey: runtimeKeys.currentProject(),
    queryFn: async () => ({ id: projectId ?? undefined, path: '/workspace', worktree: '/workspace' }),
    enabled: runtimeReady && Boolean(projectId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

// ============================================================================
// Path Info Hook
// ============================================================================

export function useRuntimePathInfo() {
  const runtimeReady = useRuntimeReady();
  return useQuery<PathInfo>({
    queryKey: runtimeKeys.pathInfo(),
    queryFn: async () => ({ root: '/workspace', cwd: '/workspace', directory: '/workspace', worktree: '/workspace' }),
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
