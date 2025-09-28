import { useMutation, useQueryClient } from '@tanstack/react-query';
import { composioApi } from './utils';
import { composioKeys } from './keys';
import { toast } from 'sonner';

export const useDeleteProfile = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (profileId: string) => composioApi.deleteProfile(profileId),
    onSuccess: async (data, profileId) => {
      await queryClient.invalidateQueries({ 
        queryKey: ['composio', 'profiles']
      });
      await queryClient.refetchQueries({ 
        queryKey: ['composio', 'profiles']
      });
      queryClient.removeQueries({ queryKey: composioKeys.profiles.detail(profileId) });
      toast.success('Profile deleted successfully');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete profile');
    },
  });
};

export const useBulkDeleteProfiles = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (profileIds: string[]) => composioApi.bulkDeleteProfiles(profileIds),
    onSuccess: async (data, profileIds) => {
      await queryClient.invalidateQueries({ 
        queryKey: ['composio', 'profiles']
      });
      await queryClient.refetchQueries({ 
        queryKey: ['composio', 'profiles']
      });
      profileIds.forEach(profileId => {
        queryClient.removeQueries({ queryKey: composioKeys.profiles.detail(profileId) });
      });
      if (data.failed_profiles.length > 0) {
        toast.warning(`${data.deleted_count} profiles deleted successfully. ${data.failed_profiles.length} failed to delete.`);
      } else {
        toast.success(`${data.deleted_count} profiles deleted successfully`);
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete profiles');
    },
  });
};

export const useSetDefaultProfile = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (profileId: string) => composioApi.setDefaultProfile(profileId),
    onSuccess: async (data, profileId) => {
      await queryClient.invalidateQueries({ 
        queryKey: ['composio', 'profiles']
      });
      await queryClient.refetchQueries({ 
        queryKey: ['composio', 'profiles']
      });
      toast.success('Default profile updated successfully');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to set default profile');
    },
  });
}; 