'use client';

import { useMutation } from '@tanstack/react-query';
import { 
  createSandboxFile,
  createSandboxFileJson
} from '@/lib/api/sandbox';
import { toast } from 'sonner';
import { handleApiError } from '@/lib/error-handler';

export const useCreateSandboxFile = () => {
  return useMutation({
    mutationFn: ({ sandboxId, filePath, content }: { 
      sandboxId: string; 
      filePath: string; 
      content: string; 
    }) => createSandboxFile(sandboxId, filePath, content),
    onSuccess: () => {
      toast.success('File created successfully');
    },
    onError: (error) => {
      handleApiError(error, {
        operation: 'create file',
        resource: 'sandbox file'
      });
    }
  });
};

export const useCreateSandboxFileJson = () => {
  return useMutation({
    mutationFn: ({ sandboxId, filePath, content }: { 
      sandboxId: string; 
      filePath: string; 
      content: string; 
    }) => createSandboxFileJson(sandboxId, filePath, content),
    onSuccess: () => {
      toast.success('File created successfully');
    },
    onError: (error) => {
      handleApiError(error, {
        operation: 'create file',
        resource: 'sandbox file'
      });
    }
  });
};
