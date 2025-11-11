import { createClient } from "@/lib/supabase/client";
import { getProject as getProjectFromApi, type Project } from "@/lib/api/projects";

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
    try {
      const supabase = createClient();
  
      // Query for threads that are marked as public
      const { data: publicThreads, error: threadsError } = await supabase
        .from('threads')
        .select('project_id')
        .eq('is_public', true);
  
      if (threadsError) {
        console.error('Error fetching public threads:', threadsError);
        return [];
      }
  
      // If no public threads found, return empty array
      if (!publicThreads?.length) {
        return [];
      }
  
      // Extract unique project IDs from public threads
      const publicProjectIds = [
        ...new Set(publicThreads.map((thread) => thread.project_id)),
      ].filter(Boolean);
  
      // If no valid project IDs, return empty array
      if (!publicProjectIds.length) {
        return [];
      }
  
      // Get the projects that have public threads
      const { data: projects, error: projectsError } = await supabase
        .from('projects')
        .select('*')
        .in('project_id', publicProjectIds);
  
      if (projectsError) {
        console.error('Error fetching public projects:', projectsError);
        return [];
      }
  
      // Map database fields to our Project type
      const mappedProjects: Project[] = (projects || []).map((project) => ({
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
        is_public: true, // Mark these as public projects
      }));
  
      return mappedProjects;
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
    const supabase = createClient();
    // Sanity check to avoid update errors
    if (!projectId || projectId === '') {
      console.error('Attempted to update project with invalid ID:', projectId);
      throw new Error('Cannot update project: Invalid project ID');
    }
  
    const { data: updatedData, error } = await supabase
      .from('projects')
      .update(data)
      .eq('project_id', projectId)
      .select()
      .single();
  
    if (error) {
      console.error('Error updating project:', error);
      throw error;
    }
  
    if (!updatedData) {
      throw new Error('No data returned from update');
    }
  
    // Dispatch a custom event to notify components about the project change
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('project-updated', {
          detail: {
            projectId,
            updatedData: {
              id: updatedData.project_id,
              name: updatedData.name,
              description: updatedData.description,
            },
          },
        }),
      );
    }
  
    // Return formatted project data - use same mapping as getProject
    return {
      id: updatedData.project_id,
      name: updatedData.name,
      description: updatedData.description || '',
      created_at: updatedData.created_at,
      sandbox: updatedData.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
    };
  };