import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { threadKeys, projectKeys } from "./keys";
import { getProject, getPublicProjects, Project, updateProject } from "./utils";
import { getProjects, createProject, deleteProject } from "@/lib/api/projects";
import { toast } from 'sonner';
import { handleApiError } from '@/lib/error-handler';

export const useProjectQuery = (projectId: string | undefined, options?) => {
  return useQuery<Project>({
    queryKey: threadKeys.project(projectId || ""),
    queryFn: () =>
      projectId
        ? getProject(projectId)
        : Promise.reject("No project ID"),
    enabled: !!projectId,
    retry: 1,
    ...options,
  });
};

export const useProjects = (options?) => {
  return useQuery<Project[]>({
    queryKey: threadKeys.projects(),
    queryFn: async () => {
      const data = await getProjects();
      return data as Project[];
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    ...options,
  });
};

export const usePublicProjectsQuery = (options?) => {
  return useQuery<Project[]>({
    queryKey: threadKeys.publicProjects(),
    queryFn: () => getPublicProjects(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    ...options,
  });
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

