'use client';

import { type QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { authenticatedFetch } from '../../platform/auth';
import { useDiagnosticsStore } from '../../state/diagnostics-store';
import { getActiveOpenCodeUrl } from '../../state/server-store';
import { useSyncStore } from '../../state/sync-store';
import { opencodeKeys } from '../use-opencode-sessions';

/**
 * Creates the stable per-stream refs used by the event hook. Each ref captures
 * the first-render values of `queryClient`, `stopCompaction`, and
 * `applySyncEvent` (all stable), matching the original inline `useRef` setup.
 */
export function useEventStreamRefs(deps: {
  queryClient: QueryClient;
  stopCompaction: (sessionID: string) => void;
  applySyncEvent: (event: any) => void;
}) {
  const { queryClient, stopCompaction, applySyncEvent } = deps;

  /**
   * Resolve an absolute sandbox path to a project-relative path by stripping
   * known worktree/directory prefixes from the React Query cache.
   *
   * For example: `/workspace/desktop/express-crud-app/src/server.js` → `src/server.js`
   *
   * This is critical for LSP diagnostics: the backend sends absolute paths,
   * but the frontend file tree / file viewer uses project-relative paths.
   */
  const normalizeLspPath = useRef((absPath: string): string => {
    if (!absPath || !absPath.startsWith('/')) return absPath;

    // Collect prefixes from cached project/path data
    const prefixes: string[] = [];
    try {
      const project = queryClient.getQueryData<any>(opencodeKeys.currentProject());
      if (project?.worktree) prefixes.push(project.worktree);
      const pathInfo = queryClient.getQueryData<any>(opencodeKeys.pathInfo());
      if (pathInfo?.directory) prefixes.push(pathInfo.directory);
      if (pathInfo?.worktree) prefixes.push(pathInfo.worktree);
    } catch {
      // non-critical
    }

    // Deduplicate and sort longest first (most specific prefix wins)
    const unique = [...new Set(prefixes.filter(Boolean))].sort((a, b) => b.length - a.length);

    for (const wt of unique) {
      if (!wt || wt === '/') continue;
      const prefix = wt.endsWith('/') ? wt : wt + '/';
      if (absPath.startsWith(prefix)) {
        return absPath.slice(prefix.length);
      }
    }

    return absPath;
  });

  /** Normalize all keys in a diagnostic map from absolute to relative paths */
  const normalizeDiagnosticPaths = useRef(
    (diagsByFile: Record<string, any[]>): Record<string, any[]> => {
      const normalized: Record<string, any[]> = {};
      for (const [file, diags] of Object.entries(diagsByFile)) {
        const relPath = normalizeLspPath.current(file);
        normalized[relPath] = diags;
      }
      return normalized;
    },
  );

  /**
   * Debounced fetch of all LSP diagnostics from the backend.
   *
   * The `lsp.client.diagnostics` SSE event only carries { serverID, path }
   * (no actual diagnostic data). Multiple events fire in rapid succession
   * as the language server reports diagnostics for different files, so we
   * debounce and fetch the full diagnostics map from GET /lsp/diagnostics.
   */
  const fetchLspDiagnosticsDebounced = useRef(
    (() => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      return () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          try {
            const baseUrl = getActiveOpenCodeUrl();
            const resp = await authenticatedFetch(`${baseUrl}/lsp/diagnostics`);
            if (!resp.ok) return;
            const data = (await resp.json()) as Record<string, any[]>;
            if (data && typeof data === 'object') {
              const normalized = normalizeDiagnosticPaths.current(data);
              // The endpoint returns the *complete* diagnostics state,
              // so clear stale entries before applying the fresh data.
              const store = useDiagnosticsStore.getState();
              store.clearAll();
              store.setFromLspEvent(normalized);
            }
          } catch {
            // Silently ignore — diagnostics are non-critical and the
            // endpoint may not be available on older OpenCode versions.
          }
        }, 250);
      };
    })(),
  );

  const markSessionAbortedLocally = useRef(
    (sessionID: string, message = 'The operation was aborted because the runtime shut down.') => {
      if (!sessionID) return;
      const error = {
        name: 'AbortError',
        data: { message },
      };
      stopCompaction(sessionID);
      applySyncEvent({
        type: 'session.error',
        properties: { sessionID, error },
      } as any);
      useSyncStore.getState().setStatus(sessionID, { type: 'idle' } as any);
      useSyncStore.getState().clearOptimisticMessages(sessionID);
    },
  );

  const markSessionIdleLocally = useRef((sessionID: string) => {
    if (!sessionID) return;
    stopCompaction(sessionID);
    applySyncEvent({
      type: 'session.idle',
      properties: { sessionID },
    } as any);
    useSyncStore.getState().setStatus(sessionID, { type: 'idle' } as any);
    useSyncStore.getState().clearOptimisticMessages(sessionID);
  });

  const reconcileMissingBusySessions = useRef((nextStatuses: Record<string, any>) => {
    const previousStatuses = useSyncStore.getState().sessionStatus;
    for (const [sessionID, status] of Object.entries(previousStatuses)) {
      if (status?.type !== 'idle' && !nextStatuses[sessionID]) {
        // A brand-new session whose first prompt the server hasn't registered
        // yet is locally-busy but absent from the status snapshot. Don't idle
        // it: markSessionIdleLocally → clearOptimisticMessages would wipe the
        // optimistic user bubble before the real message.updated arrives (the
        // "message sent from home vanishes / blinks" bug). Real status/idle
        // events reconcile it once the server catches up.
        if (useSyncStore.getState().hasOptimisticMessages(sessionID)) continue;
        markSessionIdleLocally.current(sessionID);
      }
    }
  });

  return {
    normalizeLspPath,
    normalizeDiagnosticPaths,
    fetchLspDiagnosticsDebounced,
    markSessionAbortedLocally,
    markSessionIdleLocally,
    reconcileMissingBusySessions,
  };
}
