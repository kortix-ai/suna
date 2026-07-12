'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import type { Skill, ToolListItem } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Tool Hooks
// ============================================================================

export function useOpenCodeToolIds() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<string[]>({
    queryKey: opencodeKeys.toolIds(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.tool.ids();
      return unwrap(result);
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useOpenCodeTools(providerID: string, modelID: string) {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<ToolListItem[]>({
    queryKey: opencodeKeys.tools(providerID, modelID),
    queryFn: async () => {
      const client = getClient();
      const result = await client.tool.list({ provider: providerID, model: modelID });
      return unwrap(result) as ToolListItem[];
    },
    enabled: runtimeReady && !!providerID && !!modelID,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

// ============================================================================
// Skill Hooks
// ============================================================================

export function useOpenCodeSkills() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Skill[]>({
    queryKey: opencodeKeys.skills(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.skills();
      return unwrap(result) as Skill[];
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
