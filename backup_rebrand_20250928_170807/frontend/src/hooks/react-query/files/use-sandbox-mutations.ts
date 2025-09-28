'use client';

import { createMutationHook } from '@/hooks/use-query';
import { 
  createSandboxFile,
  createSandboxFileJson
} from '@/lib/api';
import { toast } from 'sonner';

export const useCreateSandboxFile = createMutationHook(
  ({ sandboxId, filePath, content }: { 
    sandboxId: string; 
    filePath: string; 
    content: string; 
  }) => createSandboxFile(sandboxId, filePath, content),
  {
    onSuccess: () => {
      toast.success('File created successfully');
    },
    errorContext: {
      operation: 'create file',
      resource: 'sandbox file'
    }
  }
);

export const useCreateSandboxFileJson = createMutationHook(
  ({ sandboxId, filePath, content }: { 
    sandboxId: string; 
    filePath: string; 
    content: string; 
  }) => createSandboxFileJson(sandboxId, filePath, content),
  {
    onSuccess: () => {
      toast.success('File created successfully');
    },
    errorContext: {
      operation: 'create file',
      resource: 'sandbox file'
    }
  }
); 