import { createSupabaseClient } from '@/constants/SupabaseConfig';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { handleApiError } from './error-handlers';

// Project type definition
export type Project = {
  id: string;
  name: string;
  description: string;
  account_id: string;
  created_at: string;
  updated_at?: string;
  sandbox: {
    vnc_preview?: string;
    sandbox_url?: string;
    id?: string;
    pass?: string;
  };
  is_public?: boolean;
  [key: string]: any;
};

// Query keys for React Query
export const projectKeys = {
  all: ['projects'] as const,
  lists: () => [...projectKeys.all, 'list'] as const,
  list: (filters: string) => [...projectKeys.lists(), { filters }] as const,
  details: () => [...projectKeys.all, 'detail'] as const,
  detail: (id: string) => [...projectKeys.details(), id] as const,
};

const getProjects = async (): Promise<Project[]> => {
  try {
    const supabase = createSupabaseClient();

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) {
      console.error('Error getting current user:', userError);
      return [];
    }

    if (!userData.user) {
      return [];
    }

    const { data, error } = await supabase
      .from('projects')
      .select(`
        *,
        threads!inner(thread_id)
      `)
      .eq('account_id', userData.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      if (
        error.code === '42501' &&
        error.message.includes('has_role_on_account')
      ) {
        console.error(
          'Permission error: User does not have proper account access',
        );
        return [];
      }
      throw error;
    }


    // Map database fields to our Project type
    const mappedProjects: Project[] = (data || []).map((project: any) => ({
      id: project.project_id,
      name: project.name || '',
      description: project.description || '',
      account_id: project.account_id,
      created_at: project.created_at,
      updated_at: project.updated_at,
      sandbox: project.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
    }));


    return mappedProjects;
  } catch (err) {
    console.error('Error fetching projects:', err);
    handleApiError(err, { operation: 'load projects', resource: 'projects' });
    return [];
  }
};

// Helper function to delete sandbox via API (matching web frontend pattern)
const deleteSandbox = async (sandboxId: string): Promise<void> => {
  try {
    const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8000/api';
    const response = await fetch(`${BACKEND_URL}/sandboxes/${sandboxId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      console.warn(`Failed to delete sandbox ${sandboxId}:`, response.statusText);
      // Don't throw - sandbox deletion is best effort
    }
  } catch (error) {
    console.warn(`Error deleting sandbox ${sandboxId}:`, error);
    // Don't throw - sandbox deletion is best effort
  }
};

// Helper function to delete a single thread with all its dependencies
const deleteThread = async (threadId: string, projectSandboxId?: string): Promise<void> => {
  const supabase = createSupabaseClient();
  
  try {
    console.log(`[API] Deleting thread ${threadId} with dependencies`);

    // 1. Delete sandbox if exists (best effort)
    if (projectSandboxId) {
      await deleteSandbox(projectSandboxId);
    }

    // 2. Delete agent runs first (to avoid foreign key constraint)
    console.log(`[API] Deleting agent runs for thread ${threadId}`);
    const { error: agentRunsError } = await supabase
      .from('agent_runs')
      .delete()
      .eq('thread_id', threadId);

    if (agentRunsError) {
      console.error('[API] Error deleting agent runs:', agentRunsError);
      throw new Error(`Error deleting agent runs: ${agentRunsError.message}`);
    }

    // 3. Delete messages
    console.log(`[API] Deleting messages for thread ${threadId}`);
    const { error: messagesError } = await supabase
      .from('messages')
      .delete()
      .eq('thread_id', threadId);

    if (messagesError) {
      console.error('[API] Error deleting messages:', messagesError);
      throw new Error(`Error deleting messages: ${messagesError.message}`);
    }

    // 4. Delete thread record
    console.log(`[API] Deleting thread record ${threadId}`);
    const { error: threadError } = await supabase
      .from('threads')
      .delete()
      .eq('thread_id', threadId);

    if (threadError) {
      console.error('[API] Error deleting thread:', threadError);
      throw new Error(`Error deleting thread: ${threadError.message}`);
    }

    console.log(`[API] Thread ${threadId} deleted successfully with all dependencies`);
  } catch (error) {
    console.error(`[API] Error deleting thread ${threadId}:`, error);
    throw error;
  }
};

const deleteProject = async (projectId: string): Promise<void> => {
  console.log('[API] Starting cascading project deletion:', projectId);
  const supabase = createSupabaseClient();
  
  try {
    // 1. Get project details including sandbox info
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('sandbox')
      .eq('project_id', projectId)
      .single();

    if (projectError) {
      console.error('[API] Error fetching project for deletion:', projectError);
      throw new Error(`Error fetching project: ${projectError.message}`);
    }

    // 2. Get all threads for this project
    const { data: threads, error: threadsError } = await supabase
      .from('threads')
      .select('thread_id')
      .eq('project_id', projectId);

    if (threadsError) {
      console.error('[API] Error fetching threads for deletion:', threadsError);
      throw new Error(`Error fetching threads: ${threadsError.message}`);
    }

    console.log(`[API] Found ${threads?.length || 0} threads to delete for project ${projectId}`);

    // 3. Delete all threads with their dependencies
    const sandboxId = project?.sandbox?.id;
    if (threads && threads.length > 0) {
      for (const thread of threads) {
        await deleteThread(thread.thread_id, sandboxId);
      }
    }

    // 4. Finally delete the project itself
    console.log(`[API] Deleting project record ${projectId}`);
    const { error: deleteError } = await supabase
      .from('projects')
      .delete()
      .eq('project_id', projectId);

    if (deleteError) {
      console.error('[API] Error deleting project:', deleteError);
      throw new Error(`Error deleting project: ${deleteError.message}`);
    }

    console.log('[API] Project deleted successfully:', projectId);
  } catch (error) {
    console.error('[API] Cascading project deletion failed:', error);
    throw error;
  }
};

// Update project function
const updateProject = async (projectId: string, updates: Partial<Project>): Promise<Project> => {
  const supabase = createSupabaseClient();
  
  try {
    console.log('[API] Updating project:', projectId, updates);
    
    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('project_id', projectId)
      .select()
      .single();

    if (error) {
      console.error('[API] Error updating project:', error);
      throw new Error(`Error updating project: ${error.message}`);
    }

    console.log('[API] Project updated successfully:', data);
    
    // Map database fields to our Project type
    const mappedProject: Project = {
      id: data.project_id,
      name: data.name || '',
      description: data.description || '',
      account_id: data.account_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
      is_public: data.is_public,
      sandbox: data.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
    };

    return mappedProject;
  } catch (error) {
    console.error('[API] Failed to update project:', error);
    throw error;
  }
};

// React Query hook for projects
export const useProjects = () => {
  return useQuery({
    queryKey: projectKeys.lists(),
    queryFn: async () => {
      const data = await getProjects();
      return data as Project[];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
    retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
  });
};

// React Query mutation hook for deleting projects
export const useDeleteProject = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: deleteProject,
    onSuccess: (data, variables) => {
      console.log('[Mutation] Delete project success:', variables);
      // Invalidate and refetch projects list
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
    onError: (error, variables) => {
      console.error('[Mutation] Failed to delete project:', variables, error);
    },
  });
};

// React Query mutation hook for updating projects
export const useUpdateProject = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ projectId, updates }: { projectId: string; updates: Partial<Project> }) => 
      updateProject(projectId, updates),
    onSuccess: (data, variables) => {
      console.log('[Mutation] Update project success:', variables.projectId);
      // Invalidate and refetch projects list
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      // Update individual project query if exists
      queryClient.setQueryData(projectKeys.detail(variables.projectId), data);
    },
    onError: (error, variables) => {
      console.error('[Mutation] Failed to update project:', variables.projectId, error);
    },
  });
}; 