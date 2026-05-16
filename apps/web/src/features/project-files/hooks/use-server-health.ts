'use client';

import { useMemo } from 'react';
import type { ServerHealth, OpenCodeProjectInfo } from '../types';

/**
 * In the project-files view, "the server" is always the backend API — there
 * is no per-sandbox OpenCode instance to health-check. Treat as healthy.
 */
export function useServerHealth(_options?: { enabled?: boolean }) {
  return useMemo(
    () => ({
      data: { healthy: true, version: 'project-files' } as ServerHealth,
      isLoading: false,
      isError: false,
      error: null as Error | null,
      refetch: async () => ({ data: { healthy: true, version: 'project-files' } } as any),
    }),
    [],
  );
}

/**
 * Project view exposes a synthetic "current project" stub so the existing
 * git-status gate (`project?.vcs === 'git'`) continues to behave correctly.
 */
export function useCurrentProject(_options?: { enabled?: boolean }) {
  const data: OpenCodeProjectInfo = {
    id: 'project-files',
    worktree: '/workspace',
    vcs: 'git',
    name: 'project',
    time: { created: Date.now(), updated: Date.now() },
    sandboxes: [],
  };
  return useMemo(
    () => ({
      data,
      isLoading: false,
      isError: false,
      error: null as Error | null,
      refetch: async () => ({ data } as any),
    }),
    [],
  );
}
