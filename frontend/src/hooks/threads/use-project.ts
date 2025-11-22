import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { threadKeys, projectKeys } from "./keys";
import { getProject, updateProject } from "./utils";
import { createProject, deleteProject } from "@/lib/api/projects";
import { toast } from 'sonner';
import { handleApiError } from '@/lib/error-handler';
import { useMemo } from 'react';
import { Project } from '@/lib/api/projects';
import { ThreadsResponse } from '@/lib/api/threads';

export const useProjectQuery = (projectId: string | undefined, options?) => {
  const queryClient = useQueryClient();
  
  // Try to get project from cached threads ONLY (don't fetch threads list!)
  const threadsQueryKey = [...threadKeys.lists(), 'paginated', 1, 50];
  const cachedThreads = queryClient.getQueryData<ThreadsResponse>(threadsQueryKey);
  
  // Derive project from cached threads ONLY (no API call to threads list!)
  const project = useMemo(() => {
    const cachedThreadsData = cachedThreads?.threads || [];
    
    if (!projectId || !cachedThreadsData.length) return undefined;
    
    const threadWithProject = cachedThreadsData.find(
      (thread: any) => thread.project_id === projectId && thread.project
    );
    
    if (!threadWithProject?.project) return undefined;
    
    const projectData = threadWithProject.project;
    return {
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
    } as Project;
  }, [projectId, cachedThreads]);
  
  return useQuery<Project>({
    queryKey: threadKeys.project(projectId || ""),
    queryFn: async () => {
      // Fetch fresh data from API
      const projectData = await getProject(projectId!);
      return projectData;
    },
    enabled: !!projectId && (options?.enabled !== false),
    retry: 1,
    initialData: project, // Use cached data immediately if available
    refetchOnWindowFocus: false, // Don't refetch on window focus (too aggressive)
    refetchOnMount: true, // Refetch when component mounts
    staleTime: 10 * 1000, // Consider fresh for 10 seconds
    ...options,
  });
};

export const useProjects = (options?) => {
  const queryClient = useQueryClient();
  
  // Get threads from React Query cache ONLY (don't fetch!)
  const threadsQueryKey = [...threadKeys.lists(), 'paginated', 1, 50];
  const cachedThreads = queryClient.getQueryData<ThreadsResponse>(threadsQueryKey);
  const threads = cachedThreads?.threads || [];
  
  // Derive projects from cached threads data ONLY (no API call!)
  const projects = useMemo(() => {
    if (!threads.length) return [];
    
    const projectsMap = new Map<string, Project>();
    
    threads.forEach((thread: any) => {
      if (thread.project && thread.project_id) {
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
  }, [threads]);
  
  return {
    data: projects,
    isLoading: false, // Not loading since we're only using cache
    error: undefined,
  };
};

export const usePublicProjectsQuery = (options?) => {
  const queryClient = useQueryClient();
  
  // Get threads from React Query cache ONLY (don't fetch!)
  const threadsQueryKey = [...threadKeys.lists(), 'paginated', 1, 50];
  const cachedThreads = queryClient.getQueryData<ThreadsResponse>(threadsQueryKey);
  const threads = cachedThreads?.threads || [];
  
  // Derive public projects from cached threads data ONLY (no API call!)
  const publicProjects = useMemo(() => {
    if (!threads.length) return [];
    
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
            icon_name: project.icon_name,
          });
        }
      }
    });
    
    return Array.from(projectsMap.values());
  }, [threads]);
  
  return {
    data: publicProjects,
    isLoading: false, // Not loading since we're only using cache
    error: undefined,
  };
};

// Project Mutations
export const useCreateProject = () => {
  const queryClient = useQueryClient();
  
  return useMutation<Project, Error, { name: string; description: string; accountId?: string }>({
    mutationFn: (data: { name: string; description: string; accountId?: string }) => 
      createProject(data, data.accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      queryClient.invalidateQueries({ queryKey: threadKeys.projects() });
      // Don't invalidate threads list - only invalidate specific project queries
      toast.success('Project created successfully');
    },
    onError: (error) => {
      handleApiError(error, {
        operation: 'create project',
        resource: 'project'
      });
    }
  });
};

export const useUpdateProjectMutation = () => {
  const queryClient = useQueryClient();
  
  return useMutation<Project, Error, { projectId: string; data: Partial<Project> }>({
    mutationFn: ({
      projectId,
      data,
    }: {
      projectId: string;
      data: Partial<Project>;
    }) => updateProject(projectId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      queryClient.invalidateQueries({ queryKey: projectKeys.details(variables.projectId) });
      queryClient.invalidateQueries({ queryKey: threadKeys.projects() });
      queryClient.invalidateQueries({ queryKey: threadKeys.project(variables.projectId) });
      // Don't invalidate threads list - only invalidate specific project
    },
  });
};

// Alias for backward compatibility
export const useUpdateProject = useUpdateProjectMutation;

export const useDeleteProject = () => {
  const queryClient = useQueryClient();
  
  return useMutation<void, Error, { projectId: string }>({
    mutationFn: ({ projectId }: { projectId: string }) => deleteProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
      queryClient.invalidateQueries({ queryKey: threadKeys.projects() });
      // Don't invalidate threads list - only invalidate specific project queries
      toast.success('Project deleted successfully');
    },
    onError: (error) => {
      handleApiError(error, {
        operation: 'delete project',
        resource: 'project'
      });
    }
  });
};
