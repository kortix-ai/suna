'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import type { Agent } from '../../core/runtime/runtime-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { unwrap } from './shared';
import { getProjectDetail } from '../../core/rest/projects-client';
import {
  projectConfigAgentsToOpenCodeAgents,
  projectConfigAgentsToRuntimeAgents,
} from '../../core/agents/composer-agents';
import { contract } from '../query-contracts';
import { qk } from '../query-keys';

// Re-export filtered agents hook for UI agent selectors
export { useVisibleAgents } from '../use-visible-agents';
// Framework-free since it moved to core; re-exported so `./react` keeps it.
export { projectConfigAgentsToOpenCodeAgents, projectConfigAgentsToRuntimeAgents };

// ============================================================================
// Agent Hooks
// ============================================================================

/**
 * Load agents. With `projectId`, the server-side project config is source of
 * truth: it returns declarative `kortix.yaml` `agents:` entries for adopted
 * projects and OpenCode file discovery for legacy projects. Without `projectId`,
 * this falls back to the sandbox OpenCode runtime.
 */
export function useRuntimeAgents(options?: { directory?: string; projectId?: string | null }) {
  const queryClient = useQueryClient();
  const directory = options?.directory;
  const projectId = options?.projectId ?? null;
  const runtimeReady = useRuntimeReady();
  return useQuery<Agent[]>({
    // This is its OWN fetch (re-derives agents from a fresh `getProjectDetail`
    // call rather than a `select` projection over the shared `qk.project.detail`
    // entry — see `useProjectConfig` for that pattern), so it keeps its own
    // cache slot. It still nests under `qk.project.detail(id)` so a detail
    // invalidation (rename, config save, sandbox provider change, …) reaches
    // it by prefix — it used to be a child of the old flat `project-detail`
    // array key for exactly that reason, and nesting under the new key
    // restores that reach.
    queryKey: projectId
      ? [...qk.project.detail(projectId), 'agents']
      : directory
        ? [...runtimeKeys.agents(), 'dir', directory]
        : runtimeKeys.agents(),
    queryFn: async () => {
      if (projectId) {
        // Through the CANONICAL entry, not a private fetch. This slot keeps its
        // own key (see above) but it used to issue its own `GET /detail` too —
        // concurrently with `useProjectConfig`'s, 259 ms apart on a real
        // session open, both 88 KB. Same fetcher, same response: fetchQuery on
        // the shared key dedupes an in-flight read and serves a fresh one.
        const detail = await queryClient.fetchQuery({
          queryKey: qk.project.detail(projectId),
          queryFn: () => getProjectDetail(projectId),
          ...contract('config'),
        });
        return projectConfigAgentsToRuntimeAgents(detail.config);
      }
      const client = getClient();
      const result = await client.app.agents(directory ? { directory } : undefined);
      const data = unwrap(result);
      return Array.isArray(data) ? data : Object.values(data as Record<string, Agent>);
    },
    enabled: projectId ? true : runtimeReady,
    staleTime: projectId ? 30_000 : Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

/** @deprecated Use `useRuntimeAgents` and select by `name`. Removed in the next major. */
export function useRuntimeAgent(agentName: string) {
  const runtimeReady = useRuntimeReady();
  return useQuery<Agent | undefined>({
    queryKey: [...runtimeKeys.agents(), agentName],
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

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `useRuntimeAgents`. Removed in the next major. */
export const useOpenCodeAgents = useRuntimeAgents;
/** @deprecated Renamed to `useRuntimeAgent`. Removed in the next major. */
export const useOpenCodeAgent = useRuntimeAgent;
