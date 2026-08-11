'use client';

/**
 * React Query bindings for the full v2 agent-config editor (the "agent builder",
 * agent-first spec §2.2). `useAgentConfig` reads an agent's whole `agents.<name>`
 * block; `useUpdateAgentConfig` writes it back to kortix.yaml. On a successful
 * save we invalidate both this hook's cache AND the workspace-detail query the
 * agents list is drawn from, so every surface reflects the fresh manifest.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type AgentConfigBlock,
  getAgentConfig,
  updateAgentConfig,
} from '@kortix/sdk';
import { invalidateWorkspace } from '@kortix/sdk/react';

export function agentConfigQueryKey(workspaceId: string, agentName: string) {
  return ['agent-config', workspaceId, agentName] as const;
}

export function useAgentConfig(workspaceId: string | undefined, agentName: string | undefined) {
  return useQuery({
    queryKey: agentConfigQueryKey(workspaceId ?? '', agentName ?? ''),
    queryFn: () => getAgentConfig(workspaceId!, agentName!),
    enabled: !!workspaceId && !!agentName,
    staleTime: 15_000,
  });
}

export function useUpdateAgentConfig(workspaceId: string, agentName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (block: AgentConfigBlock) => updateAgentConfig(workspaceId, agentName, block),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentConfigQueryKey(workspaceId, agentName) });
      // The agents list + its per-agent badges come from project-detail.
      void invalidateWorkspace(qc, workspaceId);
    },
  });
}
