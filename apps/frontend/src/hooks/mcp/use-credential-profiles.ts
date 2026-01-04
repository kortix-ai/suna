import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';

export interface CredentialProfile {
  profile_id: string;
  mcp_qualified_name: string;
  profile_name: string;
  display_name: string;
  config_keys: string[];
  is_active: boolean;
  is_default: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCredentialProfileRequest {
  mcp_qualified_name: string;
  profile_name: string;
  display_name: string;
  config: Record<string, any>;
  is_default?: boolean;
}

const API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_URL}/secure-mcp`;

async function fetchAllCredentialProfiles(): Promise<CredentialProfile[]> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('You must be logged in to view credential profiles');
  }

  const response = await fetch(`${API_BASE}/credential-profiles`, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

async function fetchCredentialProfilesForMcp(mcpQualifiedName: string): Promise<CredentialProfile[]> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('You must be logged in to view credential profiles');
  }

  const encodedName = encodeURIComponent(mcpQualifiedName);
  const response = await fetch(`${API_BASE}/credential-profiles/${encodedName}`, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

async function fetchCredentialProfileById(profileId: string): Promise<CredentialProfile> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('You must be logged in to view credential profile');
  }

  const response = await fetch(`${API_BASE}/credential-profiles/profile/${profileId}`, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

async function createCredentialProfile(data: CreateCredentialProfileRequest): Promise<CredentialProfile> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('You must be logged in to create credential profiles');
  }

  const response = await fetch(`${API_BASE}/credential-profiles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(data),
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.json();
}

async function setDefaultProfile(profileId: string): Promise<void> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('You must be logged in to set default profile');
  }

  const response = await fetch(`${API_BASE}/credential-profiles/${profileId}/set-default`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }
}

async function deleteCredentialProfile(profileId: string): Promise<void> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('You must be logged in to delete credential profiles');
  }

  const response = await fetch(`${API_BASE}/credential-profiles/${profileId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
  }
}

export function useCredentialProfiles() {
  return useQuery({
    queryKey: ['credential-profiles'],
    queryFn: fetchAllCredentialProfiles,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCredentialProfilesForMcp(mcpQualifiedName: string | null) {
  return useQuery({
    queryKey: ['credential-profiles', mcpQualifiedName],
    queryFn: () => mcpQualifiedName ? fetchCredentialProfilesForMcp(mcpQualifiedName) : Promise.resolve([]),
    enabled: !!mcpQualifiedName,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCredentialProfile(profileId: string | null) {
  return useQuery({
    queryKey: ['credential-profile', profileId],
    queryFn: () => profileId ? fetchCredentialProfileById(profileId) : Promise.resolve(null),
    enabled: !!profileId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateCredentialProfile() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: createCredentialProfile,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['credential-profiles'] });
      queryClient.invalidateQueries({ 
        queryKey: ['credential-profiles', data.mcp_qualified_name] 
      });
      toast.success(`Created credential profile: ${data.profile_name}`);
    },
    onError: (error: Error) => {
      toast.error(`Failed to create credential profile: ${error.message}`);
    },
  });
}

export function useSetDefaultProfile() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: setDefaultProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credential-profiles'] });
      toast.success('Default profile updated successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to set default profile: ${error.message}`);
    },
  });
}

export function useDeleteCredentialProfile() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: deleteCredentialProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credential-profiles'] });
      toast.success('Credential profile deleted successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete credential profile: ${error.message}`);
    },
  });
}

export function useGetDefaultProfile(mcpQualifiedName: string | null) {
  const { data: profiles } = useCredentialProfilesForMcp(mcpQualifiedName);
  return profiles?.find(profile => profile.is_default) || profiles?.[0] || null;
}

export function useHasCredentialProfiles(mcpQualifiedName: string | null) {
  const { data: profiles, isLoading } = useCredentialProfilesForMcp(mcpQualifiedName);
  return {
    hasProfiles: (profiles?.length || 0) > 0,
    profileCount: profiles?.length || 0,
    isLoading,
  };
}
