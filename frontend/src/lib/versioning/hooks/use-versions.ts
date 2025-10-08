import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { container } from '../infrastructure/container';
import { useVersionStore } from '../stores/version-store';
import { CreateVersionRequest, UpdateVersionDetailsRequest } from '../types';

const versionService = container.getVersionService();

const versionKeys = {
  all: ['versions'] as const,
  lists: () => [...versionKeys.all, 'list'] as const,
  list: (agentId: string) => [...versionKeys.lists(), agentId] as const,
  details: () => [...versionKeys.all, 'detail'] as const,
  detail: (agentId: string, versionId: string) => [...versionKeys.details(), agentId, versionId] as const,
  comparison: (agentId: string, v1: string, v2: string) => [...versionKeys.all, 'comparison', agentId, v1, v2] as const,
};

export const useAgentVersions = (agentId: string) => {
  const { setVersions, setIsLoading, setError } = useVersionStore();
  return useQuery({
    queryKey: versionKeys.list(agentId),
    queryFn: async () => {
      setIsLoading(true);
      setError(null);
      try {
        const versions = await versionService.getAllVersions(agentId);
        setVersions(versions);
        return versions;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch versions';
        setError(message);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    enabled: !!agentId,
    staleTime: 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
};

export const useAgentVersion = (agentId: string, versionId: string | null | undefined) => {
  const { setCurrentVersion } = useVersionStore();
  return useQuery({
    queryKey: versionKeys.detail(agentId, versionId!),
    queryFn: async () => {
      const version = await versionService.getVersion(agentId, versionId!);
      setCurrentVersion(version);
      return version;
    },
    enabled: !!agentId && !!versionId,
    staleTime: 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
};

export const useCreateAgentVersion = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, data }: { agentId: string; data: CreateVersionRequest }) => {
      return versionService.createVersion(agentId, data);
    },
    onSuccess: (newVersion, { agentId }) => {
      // Invalidate both version list and agent data to update current version
      queryClient.invalidateQueries({ queryKey: versionKeys.list(agentId) });
      queryClient.invalidateQueries({ queryKey: ['agents', 'detail', agentId] });
      // Also invalidate the specific version query
      if (newVersion?.versionId?.value) {
        queryClient.invalidateQueries({ queryKey: versionKeys.detail(agentId, newVersion.versionId.value) });
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create version');
    },
  });
};

export const useActivateAgentVersion = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, versionId }: { agentId: string; versionId: string }) => {
      return versionService.activateVersion(agentId, versionId);
    },
    onSuccess: (_, { agentId }) => {
      queryClient.invalidateQueries({ queryKey: versionKeys.list(agentId) });
      queryClient.invalidateQueries({ queryKey: ['agents', 'detail', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Version activated successfully');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to activate version');
    },
  });
};

export const useUpdateVersionDetails = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      agentId, 
      versionId, 
      data 
    }: { 
      agentId: string; 
      versionId: string; 
      data: UpdateVersionDetailsRequest 
    }) => {
      return versionService.updateVersionDetails(agentId, versionId, data);
    },
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
  });
}; 