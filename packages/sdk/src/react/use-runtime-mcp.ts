'use client';

/**
 * useRuntimeMcp — React Query hooks for MCP (Model Context Protocol) server management.
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
import { getClient } from '../core/runtime/client';
import { runtimeKeys, useRuntimeMcpStatus } from './use-runtime-sessions';
import type { McpStatus } from './use-runtime-sessions';

// ============================================================================
// Re-export the existing status query hook for convenience
// ============================================================================

export { useRuntimeMcpStatus };
export type { McpStatus };

// ============================================================================
// Helper: unwrap SDK response
// ============================================================================

function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error) {
    // `error`'s shape varies per endpoint's typed error union — duck-type
    // defensively via `unknown` rather than assume a shape.
    const err = result.error;
    const status = (result.response as Response | undefined)?.status;
    const errRec = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
    const dataRec =
      errRec?.data && typeof errRec.data === 'object' ? (errRec.data as Record<string, unknown>) : undefined;
    const msg =
      dataRec?.message ||
      errRec?.message ||
      errRec?.error ||
      (typeof err === 'string' ? err : null) ||
      (typeof err === 'object' ? JSON.stringify(err) : null) ||
      (status ? `Server returned ${status}` : 'SDK request failed');
    throw new Error(String(msg));
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
      queryClient.setQueryData(runtimeKeys.mcpStatus(), data);
      // Also refresh tool IDs since new server may expose tools
      queryClient.refetchQueries({ queryKey: runtimeKeys.toolIds(), type: 'active' });
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
      await queryClient.cancelQueries({ queryKey: runtimeKeys.mcpStatus() });
      const prev = queryClient.getQueryData<Record<string, McpStatus>>(runtimeKeys.mcpStatus());
      if (prev) {
        queryClient.setQueryData(runtimeKeys.mcpStatus(), {
          ...prev,
          [name]: { status: 'connected' } as McpStatus,
        });
      }
      return { prev };
    },
    onError: (_err, _name, context) => {
      // Rollback on error
      if (context?.prev) {
        queryClient.setQueryData(runtimeKeys.mcpStatus(), context.prev);
      }
    },
    onSettled: () => {
      queryClient.refetchQueries({ queryKey: runtimeKeys.mcpStatus(), type: 'active' });
      queryClient.refetchQueries({ queryKey: runtimeKeys.toolIds(), type: 'active' });
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
      await queryClient.cancelQueries({ queryKey: runtimeKeys.mcpStatus() });
      const prev = queryClient.getQueryData<Record<string, McpStatus>>(runtimeKeys.mcpStatus());
      if (prev) {
        queryClient.setQueryData(runtimeKeys.mcpStatus(), {
          ...prev,
          [name]: { status: 'disabled' } as McpStatus,
        });
      }
      return { prev };
    },
    onError: (_err, _name, context) => {
      if (context?.prev) {
        queryClient.setQueryData(runtimeKeys.mcpStatus(), context.prev);
      }
    },
    onSettled: () => {
      queryClient.refetchQueries({ queryKey: runtimeKeys.mcpStatus(), type: 'active' });
      queryClient.refetchQueries({ queryKey: runtimeKeys.toolIds(), type: 'active' });
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
      queryClient.refetchQueries({ queryKey: runtimeKeys.mcpStatus(), type: 'active' });
      queryClient.refetchQueries({ queryKey: runtimeKeys.toolIds(), type: 'active' });
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
      queryClient.refetchQueries({ queryKey: runtimeKeys.mcpStatus(), type: 'active' });
    },
  });
}
