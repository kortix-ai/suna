'use client';

/**
 * React Query bindings for the full v2 agent-config editor (the "agent builder",
 * agent-first spec §2.2). `useAgentConfig` reads an agent's whole `agents.<name>`
 * block; `useUpdateAgentConfig` writes it back to kortix.yaml. On a successful
 * save we write the response into this hook's cache and invalidate the
 * project-detail query the agents list is drawn from, so every surface
 * reflects the fresh manifest.
 */

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type AgentConfigBlock,
  type AgentConfigResponse,
  getAgentConfig,
  updateAgentConfig,
} from '@kortix/sdk';
import { contract, invalidateProject } from '@kortix/sdk/react';

export function agentConfigQueryKey(projectId: string, agentName: string) {
  return ['agent-config', projectId, agentName] as const;
}

/**
 * Keyed on the route's agent name, not on project-detail having listed it, so
 * the agent page runs this read in parallel with detail instead of after it.
 * An agent missing from the manifest answers 404; the global retry policy
 * never retries a 4xx, and the page's not-found state comes from detail.
 * `config` freshness: this app's own save writes the cache (below).
 */
export function useAgentConfig(projectId: string | undefined, agentName: string | undefined) {
  return useQuery({
    queryKey: agentConfigQueryKey(projectId ?? '', agentName ?? ''),
    queryFn: () => getAgentConfig(projectId!, agentName!),
    enabled: !!projectId && !!agentName,
    ...contract('config'),
  });
}

/**
 * Start the agent page's config read before the navigation, on card intent.
 * Same key and freshness as {@link useAgentConfig}, so the page renders from
 * it; a fresh entry is not read again.
 */
export function prefetchAgentConfig(queryClient: QueryClient, projectId: string, agentName: string) {
  void queryClient.prefetchQuery({
    queryKey: agentConfigQueryKey(projectId, agentName),
    queryFn: () => getAgentConfig(projectId, agentName),
    ...contract('config'),
  });
}

type AgentConfigSaveResponse = Awaited<ReturnType<typeof updateAgentConfig>>;

export function applyAgentConfigSaveResponse(
  queryClient: QueryClient,
  projectId: string,
  agentName: string,
  response: AgentConfigSaveResponse,
) {
  queryClient.setQueryData<AgentConfigResponse>(
    agentConfigQueryKey(projectId, agentName),
    (current) => ({
      agent: response.agent,
      schema_version: response.schema_version,
      editable: current?.editable ?? response.schema_version === 2,
      default_agent: current?.default_agent ?? null,
      block: response.block,
    }),
  );
}

export function useUpdateAgentConfig(projectId: string, agentName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (block: AgentConfigBlock) => updateAgentConfig(projectId, agentName, block),
    onSuccess: (response) => {
      // The save response is the committed block, so the cache takes it as is.
      // A refetch would repeat the forced Git read for data already in hand.
      applyAgentConfigSaveResponse(qc, projectId, agentName, response);
      // The agents list + its per-agent badges come from project-detail.
      void invalidateProject(qc, projectId);
    },
  });
}
