import { createMutationHook, createQueryHook } from '@/hooks/use-query';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { versionKeys } from './keys';
import { getAgentVersions, getAgentVersion, createAgentVersion, activateAgentVersion, updateAgentVersionDetails, AgentVersion, AgentVersionCreateRequest } from './utils';

export const useAgentVersions = (agentId: string) => {
  return createQueryHook(
    versionKeys.list(agentId),
    () => getAgentVersions(agentId).then(versions => versions.sort((a, b) => b.version_number - a.version_number)),
    {
      enabled: !!agentId,
      staleTime: 30000,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
    }
  )();
};

export const useAgentVersion = (agentId: string, versionId: string | null | undefined) => {
  return createQueryHook(
    versionKeys.detail(agentId, versionId!),
    () => getAgentVersion(agentId, versionId!),
    {
      enabled: !!agentId && !!versionId,
      staleTime: 30000,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
    }
  )();
};

export const useCreateAgentVersion = () => {
  const queryClient = useQueryClient();

  return createMutationHook(
    async ({ agentId, data }: { agentId: string; data: AgentVersionCreateRequest }) => {
      return createAgentVersion(agentId, data);
    },
    {
      onSuccess: (newVersion, { agentId }) => {
        queryClient.invalidateQueries({ queryKey: versionKeys.list(agentId) });
        queryClient.invalidateQueries({ queryKey: ['agents', 'detail', agentId] });
        if (newVersion?.version_id) {
          queryClient.invalidateQueries({ queryKey: versionKeys.detail(agentId, newVersion.version_id) });
        }
      },
      onError: (error: Error) => {
        toast.error(error.message || 'Failed to create version');
      },
    }
  )();
};

export const useActivateAgentVersion = () => {
  const queryClient = useQueryClient();

  return createMutationHook(
    async ({ agentId, versionId }: { agentId: string; versionId: string }) => {
      return activateAgentVersion(agentId, versionId);
    },
    {
      onSuccess: (_, { agentId }) => {
        queryClient.invalidateQueries({ queryKey: versionKeys.list(agentId) });
        queryClient.invalidateQueries({ queryKey: ['agents', 'detail', agentId] });
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        toast.success('Version activated successfully');
      },
      onError: (error: Error) => {
        toast.error(error.message || 'Failed to activate version');
      },
    }
  )();
};

export const useUpdateVersionDetails = () => {
  const queryClient = useQueryClient();

  return createMutationHook(
    async ({ 
      agentId, 
      versionId, 
      data 
    }: { 
      agentId: string; 
      versionId: string; 
      data: { version_name?: string; change_description?: string }
    }) => {
      return updateAgentVersionDetails(agentId, versionId, data);
    },
    {
      onSuccess: (updatedVersion, { agentId, versionId }) => {
        queryClient.invalidateQueries({ queryKey: versionKeys.list(agentId) });
        queryClient.invalidateQueries({ queryKey: versionKeys.detail(agentId, versionId) });
        queryClient.invalidateQueries({ queryKey: ['agents', 'detail', agentId] });
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        toast.success('Version details updated successfully');
      },
      onError: (error: Error) => {
        toast.error(error.message || 'Failed to update version details');
      },
    }
  )();
};

export type { AgentVersion, AgentVersionCreateRequest };
