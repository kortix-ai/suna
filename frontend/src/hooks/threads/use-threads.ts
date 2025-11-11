import { useQuery, useMutation } from "@tanstack/react-query";
import { threadKeys } from "./keys";
import { Thread, updateThread, toggleThreadPublicStatus, deleteThread, getThread } from "./utils";
import { getThreads } from "@/lib/api/threads";

export const useThreadQuery = (threadId: string, options?) => {
  return useQuery<Thread>({
    queryKey: threadKeys.details(threadId),
    queryFn: () => getThread(threadId),
    enabled: !!threadId,
    retry: 1,
    ...options,
  });
};

export const useThreads = (options?) => {
  return useQuery<Thread[]>({
    queryKey: threadKeys.lists(),
    queryFn: async () => {
      const data = await getThreads();
      return data as Thread[];
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    ...options,
  });
};

export const useToggleThreadPublicStatus = () => {
  return useMutation<Thread, Error, { threadId: string; isPublic: boolean }>({
    mutationFn: ({
      threadId,
      isPublic,
    }: {
      threadId: string;
      isPublic: boolean;
    }) => toggleThreadPublicStatus(threadId, isPublic)
  });
};

export const useUpdateThreadMutation = () => {
  return useMutation<Thread, Error, { threadId: string; data: Partial<Thread> }>({
    mutationFn: ({
      threadId,
      data,
    }: {
      threadId: string;
      data: Partial<Thread>;
    }) => updateThread(threadId, data)
  });
};

export const useDeleteThreadMutation = () => {
  return useMutation<void, Error, { threadId: string }>({
    mutationFn: ({ threadId }: { threadId: string }) => deleteThread(threadId)
  });
};

export const useThreadsForProject = (projectId: string, options?) => {
  return useQuery<Thread[]>({
    queryKey: threadKeys.byProject(projectId),
    queryFn: () => getThreads(projectId),
    enabled: !!projectId,
    retry: 1,
    ...options,
  });
};

