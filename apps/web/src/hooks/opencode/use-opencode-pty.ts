'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '@/lib/opencode-sdk';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { getAuthToken } from '@/lib/auth-token';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import type { Pty } from '@opencode-ai/sdk/v2/client';

export type { Pty };

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

// ============================================================================
// Helper: unwrap SDK response
// ============================================================================

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    const err = result.error as any;
    throw new Error(err?.data?.message || err?.message || 'SDK request failed');
  }
  return result.data as T;
}

// ============================================================================
// Hooks
// ============================================================================

export function useOpenCodePtyList(options?: { enabled?: boolean; serverUrl?: string }) {
  const activeUrl = getActiveOpenCodeUrl();
  const serverUrl = options?.serverUrl ?? activeUrl;
  const runtimeReady = useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);
  return useQuery<Pty[]>({
    queryKey: ptyKeys.list(serverUrl),
    queryFn: async () => {
      const client = getClient();
      const result = await client.pty.list();
      return unwrap(result);
    },
    staleTime: Infinity, // SSE pty.* events trigger refetch
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: runtimeReady && (options?.enabled ?? true),
  });
}

export function useCreatePty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options?: {
      command?: string;
      args?: string[];
      cwd?: string;
      title?: string;
      env?: Record<string, string>;
    }) => {
      const client = getClient();
      const result = await client.pty.create(options as any);
      return unwrap(result);
    },
    onSuccess: () => {
      // SSE pty.created will also fire; this is instant feedback
      queryClient.refetchQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
    },
  });
}

export function useRemovePty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const client = getClient();
      const result = await client.pty.remove({ ptyID: id } as any);
      unwrap(result);
    },
    onSuccess: () => {
      // SSE pty.deleted will also fire
      queryClient.refetchQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
    },
  });
}

export function useUpdatePty() {
  return useMutation({
    mutationFn: async ({
      id,
      title,
      size,
    }: {
      id: string;
      title?: string;
      size?: { rows: number; cols: number };
    }) => {
      const client = getClient();
      const result = await client.pty.update({ ptyID: id, title, size } as any);
      return unwrap(result);
    },
  });
}

// ============================================================================
// WebSocket URL helper
// ============================================================================

export async function getPtyWebSocketUrl(ptyId: string, serverUrl?: string): Promise<string> {
  const baseUrl = serverUrl || getActiveOpenCodeUrl();
  const wsUrl = (() => {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'https:') {
        parsed.protocol = 'wss:';
      } else if (parsed.protocol === 'http:') {
        parsed.protocol = 'ws:';
      }

      // Browsers block ws:// from an https page (mixed content).
      // Force secure WS in that scenario to avoid deployment-only failures.
      if (typeof window !== 'undefined' && window.location.protocol === 'https:' && parsed.protocol === 'ws:') {
        parsed.protocol = 'wss:';
      }

      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    }
  })();
  const url = `${wsUrl}/pty/${ptyId}/connect`;
  // Browser WebSocket API doesn't support custom headers, so inject the
  // auth token as a query parameter for the backend proxy to authenticate.
  const token = await getAuthToken();
  if (token) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }
  return url;
}
