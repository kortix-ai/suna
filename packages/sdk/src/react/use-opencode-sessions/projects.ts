'use client';

import { useQuery } from '@tanstack/react-query';
import type { Project, Path as PathInfo } from '../../core/runtime/runtime-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { getRuntimePathInfo, getRuntimeProjectInfo } from '../runtime-actions';

// ============================================================================
// Project Hooks
// ============================================================================

export function useRuntimeCurrentProject() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Project>({
    queryKey: runtimeKeys.currentProject(),
    // The workspace route on a box with the session-log actions, else `/project/current`.
    queryFn: getRuntimeProjectInfo,
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
    // The workspace route on a box with the session-log actions, else `/path`.
    queryFn: getRuntimePathInfo,
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

