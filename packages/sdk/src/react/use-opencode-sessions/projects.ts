'use client';

import { useQuery } from '@tanstack/react-query';
import { getWorkspaceClient } from '../../core/runtime/client';
import type { Project, Path as PathInfo } from '@opencode-ai/sdk/v2/client';
import { useCurrentRuntime } from '../use-current-runtime';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Project Hooks
// ============================================================================

export function useOpenCodeProjects() {
  const runtimeReady = useOpenCodeRuntimeReady();
  const workspaceUrl = useCurrentRuntime((state) => state.workspaceUrl);
  const dataRuntimeKind = useCurrentRuntime((state) => state.dataRuntimeKind);
  const serverId = useCurrentRuntime(
    (state) => state.workspaceSandboxId ?? state.sandboxId,
  ) ?? undefined;
  const workspaceReady = dataRuntimeKind !== 'environment' || Boolean(workspaceUrl);
  return useQuery<Project[]>({
    queryKey: opencodeKeys.projects(serverId),
    queryFn: async () => {
      const client = getWorkspaceClient();
      const result = await client.project.list();
      return unwrap(result);
    },
    enabled: runtimeReady && workspaceReady,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

export function useOpenCodeCurrentProject() {
  const runtimeReady = useOpenCodeRuntimeReady();
  const workspaceUrl = useCurrentRuntime((state) => state.workspaceUrl);
  const dataRuntimeKind = useCurrentRuntime((state) => state.dataRuntimeKind);
  const serverId = useCurrentRuntime(
    (state) => state.workspaceSandboxId ?? state.sandboxId,
  ) ?? undefined;
  const workspaceReady = dataRuntimeKind !== 'environment' || Boolean(workspaceUrl);
  return useQuery<Project>({
    queryKey: opencodeKeys.currentProject(serverId),
    queryFn: async () => {
      const client = getWorkspaceClient();
      const result = await client.project.current();
      return unwrap(result);
    },
    enabled: runtimeReady && workspaceReady,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

// ============================================================================
// Path Info Hook
// ============================================================================

export function useOpenCodePathInfo() {
  const runtimeReady = useOpenCodeRuntimeReady();
  const workspaceUrl = useCurrentRuntime((state) => state.workspaceUrl);
  const dataRuntimeKind = useCurrentRuntime((state) => state.dataRuntimeKind);
  const serverId = useCurrentRuntime(
    (state) => state.workspaceSandboxId ?? state.sandboxId,
  ) ?? undefined;
  const workspaceReady = dataRuntimeKind !== 'environment' || Boolean(workspaceUrl);
  return useQuery<PathInfo>({
    queryKey: opencodeKeys.pathInfo(serverId),
    queryFn: async () => {
      const client = getWorkspaceClient();
      const result = await client.path.get();
      return unwrap(result);
    },
    enabled: runtimeReady && workspaceReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
