'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { McpStatus } from '../../core/runtime/wire-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { unwrap } from './shared';

// ============================================================================
// MCP Status Hook
// ============================================================================

export function useRuntimeMcpStatus() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Record<string, McpStatus>>({
    queryKey: runtimeKeys.mcpStatus(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.mcp.status();
      return unwrap(result) as Record<string, McpStatus>;
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}
