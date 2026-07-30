'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createAgentConfig,
  getAgentConfig,
  previewAgentConfig,
  repairAgentBehavior,
  updateAgentConfig,
  updateProjectDefaultAgent,
  type CreateAgentConfigInput,
  type CreateAgentConfigResponse,
  type RepairAgentBehaviorInput,
  type RepairAgentBehaviorResponse,
} from '../core/rest/projects-client';
import { changeRequestsKey } from './use-change-requests';

export const agentConfigKey = (
  projectId: string | null | undefined,
  agentName: string | null | undefined,
) => ['project-agent-config', projectId, agentName] as const;

export function useAgentConfig(
  projectId: string | null | undefined,
  agentName: string | null | undefined,
) {
  return useQuery({
    queryKey: agentConfigKey(projectId, agentName),
    queryFn: () => getAgentConfig(projectId as string, agentName as string),
    enabled: !!projectId && !!agentName,
  });
}

export function useAgentConfigMutations(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  const invalidateAgentChange = (agentName: string) => {
    queryClient.invalidateQueries({ queryKey: agentConfigKey(projectId, agentName) });
    queryClient.invalidateQueries({ queryKey: ['project-config', projectId] });
    queryClient.invalidateQueries({ queryKey: ['project-detail', projectId, 'agents'] });
    queryClient.invalidateQueries({ queryKey: changeRequestsKey(projectId) });
  };

  const preview = useMutation({
    mutationFn: (input: Parameters<typeof previewAgentConfig>[1]) =>
      previewAgentConfig(projectId as string, input),
  });

  const create = useMutation({
    mutationFn: (input: CreateAgentConfigInput) => createAgentConfig(projectId as string, input),
    onSuccess: (response: Pick<CreateAgentConfigResponse, 'agent_name'>) =>
      invalidateAgentChange(response.agent_name),
  });

  const update = useMutation({
    mutationFn: (args: {
      agentName: string;
      block: Parameters<typeof updateAgentConfig>[2];
    }) => updateAgentConfig(projectId as string, args.agentName, args.block),
    onSuccess: (response: { agent: string }) => invalidateAgentChange(response.agent),
  });

  const repairBehavior = useMutation({
    mutationFn: (args: { agentName: string; input: RepairAgentBehaviorInput }) =>
      repairAgentBehavior(projectId as string, args.agentName, args.input),
    onSuccess: (response: Pick<RepairAgentBehaviorResponse, 'agent_name'>) =>
      invalidateAgentChange(response.agent_name),
  });

  const setDefault = useMutation({
    mutationFn: (agentName: string) => updateProjectDefaultAgent(projectId as string, agentName),
    onSuccess: (response: { default_agent: string }) =>
      invalidateAgentChange(response.default_agent),
  });

  return { preview, create, update, repairBehavior, setDefault };
}
