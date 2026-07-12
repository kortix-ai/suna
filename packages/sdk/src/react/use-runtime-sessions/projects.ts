'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Project, Path as PathInfo } from '../../core/runtime/wire-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Project Hooks
// ============================================================================

export function useRuntimeProjects() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Project[]>({
    queryKey: runtimeKeys.projects(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.project.list();
      return unwrap(result);
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

export function useRuntimeCurrentProject() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Project>({
    queryKey: runtimeKeys.currentProject(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.project.current();
      return unwrap(result);
    },
    enabled: runtimeReady,
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
    queryFn: async () => {
      const client = getClient();
      const result = await client.path.get();
      return unwrap(result);
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
