import { handleApiError } from '../error-handler';
import { backendApi } from '../api-client';
import { getThreadsPaginated } from './threads';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export type Project = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at?: string;
  sandbox: {
    vnc_preview?: string;
    sandbox_url?: string;
    id?: string;
    pass?: string;
  };
  is_public?: boolean;
  icon_name?: string | null;
  [key: string]: any;
};

// Note: getProjects() is no longer used directly
// Use useProjects() hook instead, which derives projects from cached threads
// This avoids duplicate API calls

// Note: getProject() should not be called directly anymore
// Use useProjectQuery() hook instead, which derives from cached threads
// This is kept for backward compatibility but should be deprecated
export const getProject = async (projectId: string): Promise<Project> => {
  console.warn('getProject() called directly - use useProjectQuery() hook instead');
  
  try {
    // Get project by finding a thread with this project_id
    // This makes a direct API call - prefer useProjectQuery() hook instead
    const response = await getThreadsPaginated(undefined, 1, 50);

    if (!response?.threads) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Find thread with matching project_id
    const threadWithProject = response.threads.find(
      (thread: any) => thread.project_id === projectId && thread.project
    );

    if (!threadWithProject?.project) {
      throw new Error(`Project not found or not accessible: ${projectId}`);
    }

    const projectData = threadWithProject.project;

    // Ensure sandbox is active if it exists
    if (projectData.sandbox?.id) {
      const ensureSandboxActive = async () => {
        const maxRetries = 5;
        const baseDelay = 2000;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const sandboxResponse = await backendApi.post(
              `/project/${projectId}/sandbox/ensure-active`,
              {},
              { showErrors: false }
            );

            if (sandboxResponse.error) {
              if (attempt < maxRetries - 1) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
                console.log(`Sandbox ensure-active failed (${sandboxResponse.error.code}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
              }
              
              console.warn(
                `Failed to ensure sandbox is active after all retries: ${sandboxResponse.error.message}`,
              );
              return;
            }
            
            try {
              const result = sandboxResponse.data;
              const sandboxId = result?.sandbox_id;
              if (sandboxId) {
                console.log('Sandbox is active:', sandboxId);
                
                window.dispatchEvent(new CustomEvent('sandbox-active', {
                  detail: { sandboxId, projectId }
                }));
              }
            } catch (parseError) {
              console.warn('Sandbox active but failed to parse response:', parseError);
            }
            return;
          } catch (sandboxError) {
            if (attempt < maxRetries - 1) {
              const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
              console.log(`Error ensuring sandbox active, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            console.warn('Failed to ensure sandbox is active after all retries:', sandboxError);
          }
        }
      };

      ensureSandboxActive();
    }

    const mappedProject: Project = {
      id: projectData.project_id,
      name: projectData.name || '',
      description: projectData.description || '',
      is_public: projectData.is_public || false,
      created_at: projectData.created_at,
      updated_at: projectData.updated_at,
      sandbox: projectData.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
      icon_name: projectData.icon_name,
    };

    return mappedProject;
  } catch (error) {
    console.error(`Error fetching project ${projectId}:`, error);
    handleApiError(error, { operation: 'load project', resource: `project ${projectId}` });
    throw error;
  }
};

export const createProject = async (
  projectData: { name: string; description: string },
  accountId?: string,
): Promise<Project> => {
  try {
    // Projects are created via thread creation endpoint
    // The backend creates both thread and project together
    const response = await backendApi.post<{ thread_id: string; project_id: string }>(
      '/threads',
      { name: projectData.name },
      { showErrors: true }
    );

    if (response.error) {
      handleApiError(response.error, { operation: 'create project', resource: 'project' });
      throw new Error(response.error.message || 'Failed to create project');
    }

    if (!response.data?.project_id) {
      throw new Error('Failed to create project: no project_id returned');
    }

    // Fetch the created project to return full data
    const project = await getProject(response.data.project_id);
    
    return project;
  } catch (error) {
    handleApiError(error, { operation: 'create project', resource: 'project' });
    throw error;
  }
};

export const deleteProject = async (projectId: string): Promise<void> => {
  try {
    // Projects are deleted via thread deletion
    // First, find a thread with this project_id using paginated API
    const threadsResponse = await getThreadsPaginated(undefined, 1, 50);

    if (!threadsResponse?.threads) {
      handleApiError(new Error('Failed to fetch threads'), { operation: 'delete project', resource: `project ${projectId}` });
      throw new Error('Failed to find thread for project');
    }

    const threadWithProject = threadsResponse.threads.find(
      (thread: any) => thread.project_id === projectId
    );

    if (!threadWithProject) {
      throw new Error(`No thread found for project ${projectId}`);
    }

    // Delete the thread (which also deletes the project)
    const deleteResponse = await backendApi.delete(`/threads/${threadWithProject.thread_id}`, {
      showErrors: true,
    });

    if (deleteResponse.error) {
      handleApiError(deleteResponse.error, { operation: 'delete project', resource: `project ${projectId}` });
      throw new Error(deleteResponse.error.message || 'Failed to delete project');
    }
  } catch (error) {
    handleApiError(error, { operation: 'delete project', resource: `project ${projectId}` });
    throw error;
  }
};

