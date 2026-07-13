'use client';

import { useQuery } from '@tanstack/react-query';
import type { McpStatus } from '../../core/runtime/wire-types';
import { runtimeKeys, useRuntimeReady } from './keys';

// ============================================================================
// MCP Status Hook
// ============================================================================

export function useRuntimeMcpStatus() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Record<string, McpStatus>>({
    queryKey: runtimeKeys.mcpStatus(),
    queryFn: async () => {
      // MCP servers are compiled into the ACP session/new request. Connection
      // management belongs to project connectors, not a harness HTTP API.
      return {};
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}
