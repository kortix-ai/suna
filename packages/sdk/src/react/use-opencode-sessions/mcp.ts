'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../opencode/client';
import type { McpStatus } from '@opencode-ai/sdk/v2/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap } from './shared';

// ============================================================================
// MCP Status Hook
// ============================================================================

export function useOpenCodeMcpStatus() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Record<string, McpStatus>>({
    queryKey: opencodeKeys.mcpStatus(),
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
