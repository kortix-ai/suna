'use client';

import { useQuery } from '@tanstack/react-query';
import { findFiles } from '../../core/files/client';
import { runtimeKeys, useRuntimeReady } from './keys';
import type { Skill, ToolListItem } from './keys';

// ============================================================================
// Tool Hooks
// ============================================================================

export function useRuntimeToolIds() {
  const runtimeReady = useRuntimeReady();
  return useQuery<string[]>({
    queryKey: runtimeKeys.toolIds(),
    queryFn: async () => {
      return [];
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
      return [];
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
      const paths = await findFiles('SKILL.md', { type: 'file', limit: 500 });
      return paths
        .filter((location) => /(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(location))
        .map((location) => ({
          name: location.split('/').at(-2) ?? location,
          location,
        } as Skill));
    },
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}
