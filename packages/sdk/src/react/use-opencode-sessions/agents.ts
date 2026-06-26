'use client';

import { useQuery } from '@tanstack/react-query';
import { getClient } from '../../opencode/client';
import type { Agent } from '@opencode-ai/sdk/v2/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap, getLSCache, setLSCache, LS_AGENTS, CACHE_SCOPE_GLOBAL } from './shared';

// Re-export filtered agents hook for UI agent selectors
export { useVisibleAgents } from '../use-visible-agents';

// ============================================================================
// Agent Hooks
// ============================================================================

/**
 * Load opencode agents. Pass `directory` to get the project-scoped list
 * (globals + `<directory>/.opencode/agent/*.md`). Without it, opencode returns
 * the global set only.
 */
export function useOpenCodeAgents(options?: { directory?: string }) {
  const directory = options?.directory;
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Agent[]>({
    queryKey: directory ? [...opencodeKeys.agents(), 'dir', directory] : opencodeKeys.agents(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.agents(directory ? { directory } : undefined);
      const data = unwrap(result);
      const agents: Agent[] = Array.isArray(data) ? data : Object.values(data as Record<string, Agent>);
      // Agents are defined in the project repo (.kortix/opencode/agents), so the
      // roster is stable across every session that shares a working directory.
      // Cache under a directory-scoped (or global) STABLE key — not the
      // ephemeral per-sandbox server id — so a new session's picker paints from
      // cache instead of waiting on sandbox boot + the in-box /app/agents call.
      // (Previously the directory case cached nothing at all → guaranteed pop-in.)
      setLSCache(LS_AGENTS, agents, directory ? `dir:${directory}` : CACHE_SCOPE_GLOBAL);
      return agents;
    },
    placeholderData: () =>
      getLSCache<Agent[]>(LS_AGENTS, directory ? `dir:${directory}` : CACHE_SCOPE_GLOBAL),
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useOpenCodeAgent(agentName: string) {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Agent | undefined>({
    queryKey: [...opencodeKeys.agents(), agentName],
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.agents();
      const agents = unwrap(result);
      return agents.find((a: Agent) => a.name === agentName);
    },
    enabled: runtimeReady && !!agentName,
    staleTime: Infinity,
  });
}
