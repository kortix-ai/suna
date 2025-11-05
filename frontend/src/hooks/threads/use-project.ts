import { createMutationHook, createQueryHook } from "@/hooks/use-query";
import { threadKeys } from "./keys";
import { getProject, getPublicProjects, Project, updateProject } from "./utils";

export const useProjectQuery = (projectId: string | undefined) =>
  createQueryHook(
    threadKeys.project(projectId || ""),
    () =>
      projectId
        ? getProject(projectId)
        : Promise.reject("No project ID"),
    {
      enabled: !!projectId,
      retry: 1,
    }
  )();

export const useUpdateProjectMutation = () =>
  createMutationHook(
    ({
      projectId,
      data,
    }: {
      projectId: string;
      data: Partial<Project>;
    }) => updateProject(projectId, data)
  )();

export const usePublicProjectsQuery = () =>
    createQueryHook(
      threadKeys.publicProjects(),
      () =>
        getPublicProjects(),
      {
        retry: 1,
      }
    )();