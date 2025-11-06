import { useMutation } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { AgentUpdateRequest, updateAgent } from './utils';
import { agentKeys } from './keys';

export const useUpdateAgentMCPs = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ agentId, ...data }: { agentId: string } & AgentUpdateRequest) => 
      updateAgent(agentId, data),
    onSuccess: (data, variables) => {
      // Update the cache optimistically
      queryClient.setQueryData(agentKeys.detail(variables.agentId), data);
      // Also invalidate to ensure all dependent queries are refreshed
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(variables.agentId) });
      // Invalidate the list query as well in case it's being used
      queryClient.invalidateQueries({ queryKey: agentKeys.list() });
    },
  });
};
