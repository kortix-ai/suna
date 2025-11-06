import { createClient } from '@/lib/supabase/client';
import { handleApiError } from '../error-handler';
import { backendApi } from '../api-client';
import { NoAccessTokenAvailableError } from './errors';

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

export const getProjects = async (): Promise<Project[]> => {
  try {
    const response = await backendApi.get<{ threads: any[] }>('/threads', {
      showErrors: false,
    });

    if (response.error) {
      console.error('Error getting projects from threads:', response.error);
      return [];
    }

    if (!response.data?.threads) {
      return [];
    }

    const projectsMap = new Map<string, Project>();
    
    response.data.threads.forEach((thread: any) => {
      if (thread.project) {
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
            icon_name: project.icon_name,
          });
        }
      }
    });

    return Array.from(projectsMap.values());
  } catch (err) {
    console.error('Error fetching projects:', err);
    handleApiError(err, { operation: 'load projects', resource: 'projects' });
    return [];
  }
};

export const getProject = async (projectId: string): Promise<Project> => {
  const supabase = createClient();

  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new Error(`Project not found or not accessible: ${projectId}`);
      }
      throw error;
    }

    if (data.sandbox?.id) {
      const ensureSandboxActive = async () => {
        const maxRetries = 5;
        const baseDelay = 2000;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const {
              data: { session },
            } = await supabase.auth.getSession();

            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
            };

            if (session?.access_token) {
              headers['Authorization'] = `Bearer ${session.access_token}`;
            }

            const response = await fetch(
              `${API_URL}/project/${projectId}/sandbox/ensure-active`,
              {
                method: 'POST',
                headers,
              },
            );

            if (!response.ok) {
              const errorText = await response
                .text()
                .catch(() => 'No error details available');
              
              if (attempt < maxRetries - 1) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
                console.log(`Sandbox ensure-active failed (${response.status}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
              }
              
              console.warn(
                `Failed to ensure sandbox is active after all retries: ${response.status} ${response.statusText}`,
                errorText,
              );
              return;
            }
            
            try {
              const result = await response.json();
              const sandboxId = result.sandbox_id;
              console.log('Sandbox is active:', sandboxId);
              
              window.dispatchEvent(new CustomEvent('sandbox-active', {
                detail: { sandboxId, projectId }
              }));
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
      id: data.project_id,
      name: data.name || '',
      description: data.description || '',
      is_public: data.is_public || false,
      created_at: data.created_at,
      sandbox: data.sandbox || {
        id: '',
        pass: '',
        vnc_preview: '',
        sandbox_url: '',
      },
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
  const supabase = createClient();

  if (!accountId) {
    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError) throw userError;
    if (!userData.user)
      throw new Error('You must be logged in to create a project');

    accountId = userData.user.id;
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: projectData.name,
      description: projectData.description || null,
      account_id: accountId,
    })
    .select()
    .single();

  if (error) {
    handleApiError(error, { operation: 'create project', resource: 'project' });
    throw error;
  }

  const project = {
    id: data.project_id,
    name: data.name,
    description: data.description || '',
    created_at: data.created_at,
    sandbox: { id: '', pass: '', vnc_preview: '' },
  };
  return project;
};

export const updateProject = async (
  projectId: string,
  data: Partial<Project>,
): Promise<Project> => {
  const supabase = createClient();

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
    handleApiError(error, { operation: 'update project', resource: `project ${projectId}` });
    throw error;
  }

  if (!updatedData) {
    const noDataError = new Error('No data returned from update');
    handleApiError(noDataError, { operation: 'update project', resource: `project ${projectId}` });
    throw noDataError;
  }

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

  const project = {
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
  return project;
};

export const deleteProject = async (projectId: string): Promise<void> => {
  const supabase = createClient();
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('project_id', projectId);

  if (error) {
    handleApiError(error, { operation: 'delete project', resource: `project ${projectId}` });
    throw error;
  }
};

export const getPublicProjects = async (): Promise<Project[]> => {
  try {
    const supabase = createClient();

    const { data: publicThreads, error: threadsError } = await supabase
      .from('threads')
      .select('project_id')
      .eq('is_public', true);

    if (threadsError) {
      console.error('Error fetching public threads:', threadsError);
      return [];
    }

    if (!publicThreads?.length) {
      return [];
    }

    const publicProjectIds = [
      ...new Set(publicThreads.map((thread) => thread.project_id)),
    ].filter(Boolean);

    if (!publicProjectIds.length) {
      return [];
    }

    const { data: projects, error: projectsError } = await supabase
      .from('projects')
      .select('*')
      .in('project_id', publicProjectIds);

    if (projectsError) {
      console.error('Error fetching public projects:', projectsError);
      return [];
    }

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
      is_public: true,
    }));

    return mappedProjects;
  } catch (err) {
    console.error('Error fetching public projects:', err);
    handleApiError(err, { operation: 'load public projects', resource: 'public projects' });
    return [];
  }
};

