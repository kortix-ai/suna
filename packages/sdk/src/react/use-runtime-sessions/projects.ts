'use client';

import { useQuery } from '@tanstack/react-query';
import type { Project, Path as PathInfo } from '../../core/runtime/runtime-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { getRuntimePathInfo, getRuntimeWorkspaceInfo } from '../runtime-actions';

// ============================================================================
// Project Hooks
// ============================================================================

export function useRuntimeCurrentWorkspace() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Project>({
    queryKey: runtimeKeys.currentProject(),
    // The workspace route on a box with the session-log actions, else `/project/current`.
    queryFn: getRuntimeWorkspaceInfo,
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

/** @deprecated Use `useRuntimeCurrentWorkspace`. Kept permanently. */
export const useRuntimeCurrentProject = useRuntimeCurrentWorkspace;

// ============================================================================
// Path Info Hook
// ============================================================================

export function useRuntimePathInfo() {
  const runtimeReady = useRuntimeReady();
  return useQuery<PathInfo>({
    queryKey: runtimeKeys.pathInfo(),
    // The workspace route on a box with the session-log actions, else `/path`.
    queryFn: getRuntimePathInfo,
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

