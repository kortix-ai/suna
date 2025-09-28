import { createMutationHook } from '@/hooks/use-query';
import { useQueryClient } from '@tanstack/react-query';
import { AgentUpdateRequest, updateAgent } from './utils';
import { agentKeys } from './keys';

export const useUpdateAgentMCPs = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    ({ agentId, ...data }: { agentId: string } & AgentUpdateRequest) => 
      updateAgent(agentId, data),
    {
      onSuccess: (data, variables) => {
        queryClient.setQueryData(agentKeys.detail(variables.agentId), data);
      },
    }
  )();
}; 