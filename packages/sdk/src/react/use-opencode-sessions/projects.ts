'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Project, Path as PathInfo } from '@opencode-ai/sdk/v2/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Project Hooks
// ============================================================================

export function useOpenCodeProjects() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Project[]>({
    queryKey: opencodeKeys.projects(),
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

export function useOpenCodeCurrentProject() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Project>({
    queryKey: opencodeKeys.currentProject(),
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

export function useOpenCodePathInfo() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<PathInfo>({
    queryKey: opencodeKeys.pathInfo(),
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
