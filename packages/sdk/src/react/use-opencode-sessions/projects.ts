'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Project, Path as PathInfo } from '@opencode-ai/sdk/v2/client';
import { runtimeKeys, useRuntimeReady } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Project Hooks
// ============================================================================

/** @deprecated Wraps an OpenCode-only runtime route. Removed in the next major. */
export function useOpenCodeProjects() {
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

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `useRuntimeCurrentProject`. Removed in the next major. */
export const useOpenCodeCurrentProject = useRuntimeCurrentProject;
/** @deprecated Renamed to `useRuntimePathInfo`. Removed in the next major. */
export const useOpenCodePathInfo = useRuntimePathInfo;
