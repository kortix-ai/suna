'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createKortixPty,
  getKortixPtyWebSocketUrl,
  listKortixPty,
  removeKortixPty,
  updateKortixPty,
  type KortixPty,
} from '../core/runtime/pty';
import { getActiveOpenCodeUrl } from '../browser/stores/server-store';
import { isPtyQueryEnabled, resolvePtyServerUrl } from './pty-query-state';
import { useCurrentRuntime } from './use-current-runtime';

// Kortix's own PTY implementation (routes/pty.ts in kortix-sandbox-agent-
// server) — independent of whatever agent runtime is running. Kept as `Pty`
// for backward compatibility: this file's exported hook names/signatures are
// unchanged, and the shape matches OpenCode's own `Pty` entity 1:1, so every
// consumer of these hooks needed zero changes when this swapped over.
export type Pty = KortixPty;

// ============================================================================
// Query Keys
// ============================================================================

// Keys intentionally NOT under 'opencode' so they survive server-switch cache nukes.
// Scoped by serverUrl so each instance keeps its own cached list.
export const ptyKeys = {
  all: ['pty'] as const,
  list: (serverUrl: string) => ['pty', serverUrl, 'list'] as const,
  listPrefix: () => ['pty'] as const,
  detail: (id: string) => ['pty', id] as const,
};

/**
 * Optional react-query overrides for the PTY mutations. TanStack Query only
 * falls back to the host's `defaultOptions.mutations.onError` (commonly a
 * global error toast) when the mutation defines none of its own — so a host
 * whose terminal UI already surfaces failures can pass a no-op `onError`
 * to keep pty create/resize errors out of its global handler.
 */
export interface PtyMutationOptions {
  onError?: (error: unknown) => void;
  /** Keep the mutation bound to the same session runtime as the terminal. */
  serverUrl?: string;
}

/** Pure merge helper for {@link PtyMutationOptions} — spread into `useMutation`.
 *  Omits the key entirely when unset so the host default still applies. */
export function ptyMutationOverrides(
  options?: PtyMutationOptions,
): { onError?: (error: unknown) => void } {
  return options?.onError ? { onError: options.onError } : {};
}

// ============================================================================
// Hooks
// ============================================================================

export function useOpenCodePtyList(options?: { enabled?: boolean; serverUrl?: string }) {
  const runtimeUrl = useCurrentRuntime((state) => state.url);
  const activeUrl = runtimeUrl || getActiveOpenCodeUrl();
  const serverUrl = resolvePtyServerUrl(options?.serverUrl, activeUrl);
  return useQuery<Pty[]>({
    queryKey: ptyKeys.list(serverUrl),
    queryFn: () => listKortixPty(serverUrl),
    staleTime: Infinity, // SSE pty.* events trigger refetch
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    // `/kortix/pty` belongs to the sandbox daemon. It does not depend on the
    // OpenCode health signal. Waiting for that signal can disable this query
    // forever even when the terminal endpoint is already reachable.
    enabled: isPtyQueryEnabled(serverUrl, options?.enabled ?? true),
  });
}

export function useCreatePty(hookOptions?: PtyMutationOptions) {
  const queryClient = useQueryClient();
  const runtimeUrl = useCurrentRuntime((state) => state.url);
  const serverUrl = resolvePtyServerUrl(
    hookOptions?.serverUrl,
    runtimeUrl || getActiveOpenCodeUrl(),
  );

  return useMutation({
    mutationFn: (options?: {
      command?: string;
      args?: string[];
      cwd?: string;
      title?: string;
      env?: Record<string, string>;
    }) => createKortixPty(serverUrl, options),
    onSuccess: () => {
      // SSE pty.created will also fire; this is instant feedback
      queryClient.refetchQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
    },
    ...ptyMutationOverrides(hookOptions),
  });
}

export function useRemovePty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => removeKortixPty(getActiveOpenCodeUrl(), id),
    onSuccess: () => {
      // SSE pty.deleted will also fire
      queryClient.refetchQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
    },
  });
}

export function useUpdatePty(options?: PtyMutationOptions) {
  const runtimeUrl = useCurrentRuntime((state) => state.url);
  const serverUrl = resolvePtyServerUrl(
    options?.serverUrl,
    runtimeUrl || getActiveOpenCodeUrl(),
  );
  return useMutation({
    mutationFn: ({
      id,
      title,
      size,
    }: {
      id: string;
      title?: string;
      size?: { rows: number; cols: number };
    }) => updateKortixPty(serverUrl, id, { title, size }),
    ...ptyMutationOverrides(options),
  });
}

// ============================================================================
// WebSocket URL helper
// ============================================================================

export async function getPtyWebSocketUrl(ptyId: string, serverUrl?: string): Promise<string> {
  return getKortixPtyWebSocketUrl(ptyId, serverUrl || getActiveOpenCodeUrl());
}
