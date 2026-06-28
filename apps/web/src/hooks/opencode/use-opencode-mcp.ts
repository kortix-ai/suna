'use client';

/**
 * useOpenCodeMcp — React Query hooks for MCP (Model Context Protocol) server management.
 *
 * Wraps the SDK's `client.mcp.*` namespace:
 * - status()         — list all servers + their statuses
 * - add()            — register a new MCP server
 * - connect()        — connect a server by name
 * - disconnect()     — disconnect a server by name
 * - auth.start()     — start OAuth flow (returns authorization URL)
 * - auth.callback()  — complete OAuth with authorization code
 * - auth.remove()    — remove OAuth credentials
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '@/lib/opencode-sdk';
import { opencodeKeys, useOpenCodeMcpStatus } from './use-opencode-sessions';
import type { McpStatus } from './use-opencode-sessions';

// ============================================================================
// Re-export the existing status query hook for convenience
// ============================================================================

export { useOpenCodeMcpStatus };
export type { McpStatus };

// ============================================================================
// Helper: unwrap SDK response
// ============================================================================

function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error) {
    const err = result.error as any;
    const status = (result.response as Response | undefined)?.status;
    const msg =
      err?.data?.message ||
      err?.message ||
      err?.error ||
      (typeof err === 'string' ? err : null) ||
      (typeof err === 'object' ? JSON.stringify(err) : null) ||
      (status ? `Server returned ${status}` : 'SDK request failed');
    throw new Error(msg);
  }
  return result.data as T;
}

// ============================================================================
// Add MCP Server
// ============================================================================

export interface AddMcpServerParams {
  name: string;
  type: 'local' | 'remote';
  /** For local (stdio) servers: the command + args as an array */
  command?: string[];
  /** For local servers: environment variables */
  env?: Record<string, string>;
  /** For remote (HTTP/SSE) servers: the URL */
  url?: string;
  /** For remote servers: custom headers */
  headers?: Record<string, string>;
}

export function useAddMcpServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: AddMcpServerParams) => {
      const client = getClient();

      const config =
        params.type === 'local'
          ? {
              type: 'local' as const,
              command: params.command ?? [],
              ...(params.env && Object.keys(params.env).length > 0
                ? { environment: params.env }
                : {}),
            }
          : {
              type: 'remote' as const,
              url: params.url ?? '',
              ...(params.headers && Object.keys(params.headers).length > 0
                ? { headers: params.headers }
                : {}),
            };

      const result = await client.mcp.add({
        name: params.name,
        config,
      });
      return unwrap(result) as Record<string, McpStatus>;
    },
    onSuccess: (data) => {
      // Optimistically set the full status map returned by add()
      queryClient.setQueryData(opencodeKeys.mcpStatus(), data);
      // Also refresh tool IDs since new server may expose tools
      queryClient.refetchQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
    },
  });
}

// ============================================================================
// Connect MCP Server
// ============================================================================

export function useConnectMcpServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const client = getClient();
      const result = await client.mcp.connect({ name });
      return unwrap(result);
    },
    onMutate: async (name) => {
      // Optimistic update: set status to "connected"
      await queryClient.cancelQueries({ queryKey: opencodeKeys.mcpStatus() });
      const prev = queryClient.getQueryData<Record<string, McpStatus>>(opencodeKeys.mcpStatus());
      if (prev) {
        queryClient.setQueryData(opencodeKeys.mcpStatus(), {
          ...prev,
          [name]: { status: 'connected' } as McpStatus,
        });
      }
      return { prev };
    },
    onError: (_err, _name, context) => {
      // Rollback on error
      if (context?.prev) {
        queryClient.setQueryData(opencodeKeys.mcpStatus(), context.prev);
      }
    },
    onSettled: () => {
      queryClient.refetchQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
      queryClient.refetchQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
    },
  });
}

// ============================================================================
// Disconnect MCP Server
// ============================================================================

export function useDisconnectMcpServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const client = getClient();
      const result = await client.mcp.disconnect({ name });
      return unwrap(result);
    },
    onMutate: async (name) => {
      // Optimistic update: set status to "disabled"
      await queryClient.cancelQueries({ queryKey: opencodeKeys.mcpStatus() });
      const prev = queryClient.getQueryData<Record<string, McpStatus>>(opencodeKeys.mcpStatus());
      if (prev) {
        queryClient.setQueryData(opencodeKeys.mcpStatus(), {
          ...prev,
          [name]: { status: 'disabled' } as McpStatus,
        });
      }
      return { prev };
    },
    onError: (_err, _name, context) => {
      if (context?.prev) {
        queryClient.setQueryData(opencodeKeys.mcpStatus(), context.prev);
      }
    },
    onSettled: () => {
      queryClient.refetchQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
      queryClient.refetchQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
    },
  });
}

// ============================================================================
// MCP OAuth: Start
// ============================================================================

export function useMcpAuthStart() {
  return useMutation({
    mutationFn: async (name: string) => {
      const client = getClient();
      const result = await client.mcp.auth.start({ name });
      return unwrap(result) as { authorizationUrl: string };
    },
  });
}

// ============================================================================
// MCP OAuth: Callback
// ============================================================================

export function useMcpAuthCallback() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ name, code }: { name: string; code: string }) => {
      const client = getClient();
      const result = await client.mcp.auth.callback({ name, code });
      return unwrap(result) as McpStatus;
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
      queryClient.refetchQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
    },
  });
}

// ============================================================================
// MCP OAuth: Remove
// ============================================================================

export function useMcpAuthRemove() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const client = getClient();
      const result = await client.mcp.auth.remove({ name });
      return unwrap(result);
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
    },
  });
}
