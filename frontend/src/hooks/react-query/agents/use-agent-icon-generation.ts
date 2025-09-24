import { useMutation } from '@tanstack/react-query';
import { generateAgentIcon, AgentIconGenerationRequest, AgentIconGenerationResponse } from '@/lib/api';
import { toast } from 'sonner';

export const useGenerateAgentIcon = () => {
  return useMutation<AgentIconGenerationResponse, Error, AgentIconGenerationRequest>({
    mutationFn: generateAgentIcon,
    onError: (error) => {
      console.error('Error generating agent icon:', error);
      toast.error('Failed to generate agent icon. Please try again.');
    },
  });
};
