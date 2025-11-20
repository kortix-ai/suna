'use client';

import { createContext, useContext, ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';

interface ProfilePictureApiResponse {
  success: boolean;
  profile_picture_url: string | null;
}

type ProfilePictureContextValue = {
  profilePictureUrl: string | null;
  isLoading: boolean;
  uploadProfilePicture: (file: File) => Promise<ProfilePictureApiResponse>;
  deleteProfilePicture: () => Promise<ProfilePictureApiResponse | undefined>;
  isUploading: boolean;
  isDeleting: boolean;
  refetch: () => Promise<any>;
};

const ProfilePictureContext = createContext<ProfilePictureContextValue | undefined>(undefined);

export function ProfilePictureProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const supabase = createClient();

  const profilePictureQuery = useQuery({
    queryKey: ['profile', 'picture'],
    queryFn: async (): Promise<string | null> => {
      const response = await backendApi.get<ProfilePictureApiResponse>('/users/profile-picture', {
        showErrors: false,
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to load profile picture');
      }

      return response.data?.profile_picture_url ?? null;
    },
  });

  const refreshSession = async () => {
    try {
      await supabase.auth.refreshSession();
    } catch (error) {
      console.error('Failed to refresh session after profile update', error);
    }
  };

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);

      const response = await backendApi.upload<ProfilePictureApiResponse>(
        '/users/profile-picture',
        formData,
        { showErrors: true }
      );

      if (response.error || !response.data) {
        throw new Error(response.error?.message || 'Failed to upload profile picture');
      }

      return response.data;
    },
    onSuccess: async (data) => {
      await refreshSession();
      queryClient.setQueryData(['profile', 'picture'], data?.profile_picture_url ?? null);
      toast.success('Profile picture updated');
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Failed to upload profile picture');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await backendApi.delete<ProfilePictureApiResponse>(
        '/users/profile-picture',
        { showErrors: true }
      );

      if (response.error) {
        throw new Error(response.error.message || 'Failed to delete profile picture');
      }

      return response.data;
    },
    onSuccess: async (data) => {
      await refreshSession();
      queryClient.setQueryData(['profile', 'picture'], data?.profile_picture_url ?? null);
      toast.success('Profile picture removed');
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Failed to delete profile picture');
    },
  });

  const value: ProfilePictureContextValue = {
    profilePictureUrl: profilePictureQuery.data ?? null,
    isLoading: profilePictureQuery.isLoading,
    uploadProfilePicture: uploadMutation.mutateAsync,
    deleteProfilePicture: deleteMutation.mutateAsync,
    isUploading: uploadMutation.isPending,
    isDeleting: deleteMutation.isPending,
    refetch: profilePictureQuery.refetch,
  };

  return (
    <ProfilePictureContext.Provider value={value}>
      {children}
    </ProfilePictureContext.Provider>
  );
}

export function useProfilePicture() {
  const context = useContext(ProfilePictureContext);
  if (!context) {
    throw new Error('useProfilePicture must be used within a ProfilePictureProvider');
  }
  return context;
}

