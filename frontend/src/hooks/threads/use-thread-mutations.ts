'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  createThread, 
  addUserMessage 
} from '@/lib/api/threads';
import { toast } from 'sonner';
import { handleApiError } from '@/lib/error-handler';
import { deleteThread } from './utils';
import { threadKeys } from './keys';

export const useCreateThread = () => {
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) => createThread(projectId),
    onSuccess: () => {
      toast.success('Thread created successfully');
    },
    onError: (error) => {
      handleApiError(error, {
        operation: 'create thread',
        resource: 'thread'
      });
    }
  });
};

export const useAddUserMessage = () => {
  return useMutation({
    mutationFn: ({ threadId, content }: { threadId: string; content: string }) => 
      addUserMessage(threadId, content),
    onError: (error) => {
      handleApiError(error, {
        operation: 'add message',
        resource: 'message'
      });
    }
  });
};

interface DeleteThreadVariables {
  threadId: string;
  sandboxId?: string;
  isNavigateAway?: boolean;
}

export const useDeleteThread = () => {
  const queryClient = useQueryClient();
  
  return useMutation<void, Error, DeleteThreadVariables>({
    mutationFn: async ({ threadId, sandboxId }: DeleteThreadVariables) => {
      return await deleteThread(threadId, sandboxId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: threadKeys.lists() });
      await queryClient.invalidateQueries({ queryKey: threadKeys.limit() });
      await queryClient.refetchQueries({ queryKey: threadKeys.limit() });
    },
  });
};

interface DeleteMultipleThreadsVariables {
  threadIds: string[];
  threadSandboxMap?: Record<string, string>;
  onProgress?: (completed: number, total: number) => void;
}

export const useDeleteMultipleThreads = () => {
  const queryClient = useQueryClient();
  
  return useMutation<{ successful: string[]; failed: string[] }, Error, DeleteMultipleThreadsVariables>({
    mutationFn: async ({ threadIds, threadSandboxMap, onProgress }: DeleteMultipleThreadsVariables) => {
      let completedCount = 0;
      const results = await Promise.all(
        threadIds.map(async (threadId) => {
          try {
            const sandboxId = threadSandboxMap?.[threadId];
            const result = await deleteThread(threadId, sandboxId);
            completedCount++;
            onProgress?.(completedCount, threadIds.length);
            return { success: true, threadId };
          } catch (error) {
            return { success: false, threadId, error };
          }
        })
      );
      
      return {
        successful: results.filter(r => r.success).map(r => r.threadId),
        failed: results.filter(r => !r.success).map(r => r.threadId),
      };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: threadKeys.lists() });
      await queryClient.invalidateQueries({ queryKey: threadKeys.limit() });
      await queryClient.refetchQueries({ queryKey: threadKeys.limit() });
    },
  });
};
