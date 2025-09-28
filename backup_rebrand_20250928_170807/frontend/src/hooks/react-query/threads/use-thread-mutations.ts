'use client';

import { createMutationHook } from '@/hooks/use-query';
import { 
  createThread, 
  addUserMessage 
} from '@/lib/api';
import { toast } from 'sonner';

export const useCreateThread = createMutationHook(
  ({ projectId }: { projectId: string }) => createThread(projectId),
  {
    onSuccess: () => {
      toast.success('Thread created successfully');
    },
    errorContext: {
      operation: 'create thread',
      resource: 'thread'
    }
  }
);

export const useAddUserMessage = createMutationHook(
  ({ threadId, content }: { threadId: string; content: string }) => 
    addUserMessage(threadId, content),
  {
    errorContext: {
      operation: 'add message',
      resource: 'message'
    }
  }
); 