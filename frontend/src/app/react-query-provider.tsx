'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { handleApiError } from '@/lib/error-handler';
import { isLocalMode } from '@/lib/config';
import { 
  AgentRunLimitError, 
  BillingError, 
  ProjectLimitError, 
  ThreadLimitError,
  AgentCountLimitError,
  TriggerLimitError,
  CustomWorkerLimitError,
  ModelAccessDeniedError
} from '@/lib/api/errors';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20 * 1000,
            gcTime: 2 * 60 * 1000,
            retry: (failureCount, error: any) => {
              if (error?.status >= 400 && error?.status < 500) return false;
              if (error?.status === 404) return false;
              return failureCount < 3;
            },
            refetchOnMount: true,
            refetchOnWindowFocus: false,
            refetchOnReconnect: 'always',
          },
          mutations: {
            retry: (failureCount, error: any) => {
              if (error?.status >= 400 && error?.status < 500) return false;
              return failureCount < 1;
            },
            onError: (error: any) => {
              if (error instanceof BillingError || 
                  error instanceof AgentRunLimitError ||
                  error instanceof ProjectLimitError ||
                  error instanceof ThreadLimitError ||
                  error instanceof AgentCountLimitError ||
                  error instanceof TriggerLimitError ||
                  error instanceof CustomWorkerLimitError ||
                  error instanceof ModelAccessDeniedError) {
                return;
              }
              handleApiError(error, {
                operation: 'perform action',
                silent: false,
              });
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {isLocalMode() && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}

