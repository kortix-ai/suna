import { createMutationHook, createQueryHook } from "@/hooks/use-query";
import { threadKeys } from "./keys";
import { Thread, updateThread, toggleThreadPublicStatus, deleteThread, getThread } from "./utils";
import { getThreads } from "@/lib/api";

export const useThreadQuery = (threadId: string) =>
  createQueryHook(
    threadKeys.details(threadId),
    () => getThread(threadId),
    {
      enabled: !!threadId,
      retry: 1,
    }
)();

export const useToggleThreadPublicStatus = () =>
  createMutationHook(
    ({
      threadId,
      isPublic,
    }: {
      threadId: string;
      isPublic: boolean;
    }) => toggleThreadPublicStatus(threadId, isPublic)
)();

export const useUpdateThreadMutation = () =>
  createMutationHook(
    ({
      threadId,
      data,
    }: {
      threadId: string;
      data: Partial<Thread>,
    }) => updateThread(threadId, data)
  )()

export const useDeleteThreadMutation = () =>
  createMutationHook(
    ({ threadId }: { threadId: string }) => deleteThread(threadId)
)()


export const useThreadsForProject = (projectId: string) => {
  return createQueryHook(
    threadKeys.byProject(projectId),
    () => getThreads(projectId),
    {
      enabled: !!projectId,
      retry: 1,
    }
  )();
};