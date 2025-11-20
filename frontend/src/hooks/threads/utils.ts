import { createClient } from "@/lib/supabase/client";
import { getProject as getProjectFromApi, type Project } from "@/lib/api/projects";
import { backendApi } from "@/lib/api-client";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

// Re-export Project type for consistent imports
export type { Project };

export type Thread = {
    thread_id: string;
    project_id?: string | null;
    is_public?: boolean;
    created_at: string;
    updated_at: string;
    metadata?: {
      agent_id?: string;
    
      [key: string]: any;
    };
    [key: string]: any;
  };
  

  export const getThread = async (threadId: string): Promise<Thread> => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    // Build headers with optional auth token
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    // Use backend API endpoint with auth handling
    const response = await fetch(`${API_URL}/threads/${threadId}`, {
      headers,
      cache: 'no-store',
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(errorText || `Failed to fetch thread: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  };

export const updateThread = async (
    threadId: string,
    data: Partial<Thread>,
  ): Promise<Thread> => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error('You must be logged in to update a thread');
    }

    // Use backend API endpoint with auth handling
    const response = await fetch(`${API_URL}/threads/${threadId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(data),
      cache: 'no-store',
    });
  
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('Error updating thread:', errorText);
      throw new Error(`Error updating thread: ${errorText}`);
    }
  
    const updatedThread = await response.json();
    return updatedThread;
  };

export const toggleThreadPublicStatus = async (
    threadId: string,
    isPublic: boolean,
  ): Promise<Thread> => {
    return updateThread(threadId, { is_public: isPublic });
};

/**
 * Delete a thread using the backend API endpoint.
 * The backend handles deleting all associated data (messages, agent runs, project, sandbox).
 */
export const deleteThread = async (threadId: string, sandboxId?: string): Promise<void> => {
    try {
      const supabase = createClient();
      
      // Get auth session for the API request
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      // Use the backend DELETE endpoint which handles everything
      const response = await fetch(`${API_URL}/threads/${threadId}`, {
        method: 'DELETE',
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error('Error deleting thread:', errorText);
        throw new Error(`Failed to delete thread: ${errorText}`);
      }

      console.log(`Thread ${threadId} deleted successfully`);
    } catch (error) {
      console.error('Error deleting thread:', error);
      throw error;
    }
  };
  

export const getPublicProjects = async (): Promise<Project[]> => {
    // NOTE: This function should not be called directly anymore
    // Use usePublicProjectsQuery() hook instead, which derives from cached threads
    // This is kept for backward compatibility but should be deprecated
    console.warn('getPublicProjects() called directly - use usePublicProjectsQuery() hook instead');
    
    try {
      const { getThreadsPaginated } = await import('@/lib/api/threads');
      const response = await getThreadsPaginated(undefined, 1, 50);

      if (!response?.threads) {
        return [];
      }

      const threads = response.threads;

      // Filter for public threads and extract unique projects
      const projectsMap = new Map<string, Project>();
      
      threads.forEach((thread: any) => {
        if (thread.is_public && thread.project_id && thread.project) {
          const project = thread.project;
          if (!projectsMap.has(project.project_id)) {
            projectsMap.set(project.project_id, {
              id: project.project_id,
              name: project.name || '',
              description: project.description || '',
              created_at: project.created_at,
              updated_at: project.updated_at,
              sandbox: project.sandbox || {
                id: '',
                pass: '',
                vnc_preview: '',
                sandbox_url: '',
              },
              is_public: true,
            });
          }
        }
      });

      return Array.from(projectsMap.values());
    } catch (err) {
      console.error('Error fetching public projects:', err);
      return [];
    }
  };



  // Wrapper around api.ts getProject to maintain consistent imports
  // Delegates to api.ts which includes retry logic + better error handling
  export const getProject = async (projectId: string): Promise<Project> => {
    return await getProjectFromApi(projectId);
  };


  export const updateProject = async (
    projectId: string,
    data: Partial<Project>,
  ): Promise<Project> => {
    // Sanity check to avoid update errors
    if (!projectId || projectId === '') {
      console.error('Attempted to update project with invalid ID:', projectId);
      throw new Error('Cannot update project: Invalid project ID');
    }

    try {
      // NOTE: This function is called from mutations, not hooks
      // We still need to fetch threads to find the thread_id for the update
      // But we should try to use cached data first via queryClient if available
      // For now, we'll make a direct call but this could be optimized further
      const { getThreadsPaginated } = await import('@/lib/api/threads');
      const threadsResponse = await getThreadsPaginated(undefined, 1, 50);

      if (!threadsResponse?.threads) {
        throw new Error('Failed to find thread for project');
      }

      const threadWithProject = threadsResponse.threads.find(
        (thread: any) => thread.project_id === projectId
      );

      if (!threadWithProject) {
        throw new Error(`No thread found for project ${projectId}`);
      }

      // Update project via thread PATCH endpoint
      // The backend accepts 'title' for project name and 'is_public' for project visibility
      const updatePayload: any = {};
      if (data.name !== undefined) {
        updatePayload.title = data.name;
      }
      if (data.is_public !== undefined) {
        updatePayload.is_public = data.is_public;
      }

      const updateResponse = await backendApi.patch(
        `/threads/${threadWithProject.thread_id}`,
        updatePayload,
        { showErrors: true }
      );

      if (updateResponse.error) {
        throw new Error(updateResponse.error.message || 'Failed to update project');
      }

      // Fetch updated project data
      const updatedProject = await getProject(projectId);

      // Dispatch a custom event to notify components about the project change
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('project-updated', {
            detail: {
              projectId,
              updatedData: {
                id: updatedProject.id,
                name: updatedProject.name,
                description: updatedProject.description,
              },
            },
          }),
        );
      }

      return updatedProject;
    } catch (error) {
      console.error('Error updating project:', error);
      throw error;
    }
  };