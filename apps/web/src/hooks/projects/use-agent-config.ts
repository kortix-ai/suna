'use client';

/**
 * React Query bindings for the full v2 agent-config editor (the "agent builder",
 * agent-first spec §2.2). `useAgentConfig` reads an agent's whole `agents.<name>`
 * block; `useUpdateAgentConfig` writes it back to kortix.yaml. On a successful
 * save we invalidate both this hook's cache AND the project-detail query the
 * agents list is drawn from, so every surface reflects the fresh manifest.
 */

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type AgentConfigBlock,
  type AgentConfigResponse,
  getAgentConfig,
  updateAgentConfig,
} from '@kortix/sdk';
import { invalidateProject } from '@kortix/sdk/react';

export function agentConfigQueryKey(projectId: string, agentName: string) {
  return ['agent-config', projectId, agentName] as const;
}

export function useAgentConfig(projectId: string | undefined, agentName: string | undefined) {
  return useQuery({
    queryKey: agentConfigQueryKey(projectId ?? '', agentName ?? ''),
    queryFn: () => getAgentConfig(projectId!, agentName!),
    enabled: !!projectId && !!agentName,
    staleTime: 15_000,
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
      applyAgentConfigSaveResponse(qc, projectId, agentName, response);
      qc.invalidateQueries({ queryKey: agentConfigQueryKey(projectId, agentName) });
      // The agents list + its per-agent badges come from project-detail.
      void invalidateProject(qc, projectId);
    },
  });
}
