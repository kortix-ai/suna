import { useQuery, useMutation, useQueryClient, UseQueryResult, keepPreviousData } from "@tanstack/react-query";
import { threadKeys } from "./keys";
import { Thread, updateThread, toggleThreadPublicStatus, deleteThread, getThread } from "./utils";
import { getThreadsPaginated, type ThreadsResponse } from "@/lib/api/threads";
import { useMemo } from "react";

export const useThreadQuery = (threadId: string, options?) => {
  return useQuery<Thread>({
    queryKey: threadKeys.details(threadId),
    queryFn: () => getThread(threadId),
    enabled: !!threadId,
    retry: 1,
    ...options,
  });
};

/**
 * Unified threads hook that uses paginated API.
 * Uses keepPreviousData to show current page while loading new page.
 */
export const useThreads = (options?: {
  page?: number;
  limit?: number;
  enabled?: boolean;
}) => {
  const page = options?.page ?? 1;
  const limit = options?.limit ?? 50;
  const queryKey = [...threadKeys.lists(), 'paginated', page, limit];
  
  return useQuery<ThreadsResponse>({
    queryKey,
    queryFn: async () => {
      return await getThreadsPaginated(undefined, page, limit);
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    // Keep showing current page data while loading next page
    placeholderData: keepPreviousData,
    enabled: options?.enabled !== false,
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
  // Use paginated API and filter client-side for project-specific threads
  const threadsQuery = useThreads({
    page: 1,
    limit: 50, // Use 50 to match other components and avoid duplicate fetches
    enabled: !!projectId && (options?.enabled !== false),
  });
  
  const projectThreads = useMemo(() => {
    if (!threadsQuery.data?.threads) return [];
    return threadsQuery.data.threads.filter((thread: Thread) => thread.project_id === projectId);
  }, [threadsQuery.data, projectId]);
  
  return {
    data: projectThreads,
    isLoading: threadsQuery.isLoading,
    error: threadsQuery.error,
  };
};

