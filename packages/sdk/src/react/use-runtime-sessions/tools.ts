'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { runtimeKeys, useRuntimeReady } from './keys';
import type { Skill, ToolListItem } from './keys';
import { unwrap } from './shared';

// ============================================================================
// Tool Hooks
// ============================================================================

export function useRuntimeToolIds() {
  const runtimeReady = useRuntimeReady();
  return useQuery<string[]>({
    queryKey: runtimeKeys.toolIds(),
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

export function useRuntimeTools(providerID: string, modelID: string) {
  const runtimeReady = useRuntimeReady();
  return useQuery<ToolListItem[]>({
    queryKey: runtimeKeys.tools(providerID, modelID),
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

export function useRuntimeSkills() {
  const runtimeReady = useRuntimeReady();
  return useQuery<Skill[]>({
    queryKey: runtimeKeys.skills(),
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
