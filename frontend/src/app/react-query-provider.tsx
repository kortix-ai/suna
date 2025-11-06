'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { handleApiError } from '@/lib/error-handler';
import { isLocalMode } from '@/lib/config';
import { AgentRunLimitError, BillingError } from '@/lib/api/errors';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20 * 1000, // 20 seconds
            gcTime: 2 * 60 * 1000, // 2 minutes (formerly cacheTime)
            retry: (failureCount, error: any) => {
              // Don't retry client errors (4xx)
              if (error?.status >= 400 && error?.status < 500) return false;
              // Don't retry 404s
              if (error?.status === 404) return false;
              // Retry up to 3 times for other errors
              return failureCount < 3;
            },
            refetchOnMount: true,
            refetchOnWindowFocus: false, // Avoid annoying refetches
            refetchOnReconnect: 'always', // Good for real-time apps
          },
          mutations: {
            retry: (failureCount, error: any) => {
              // Don't retry client errors (4xx)
              if (error?.status >= 400 && error?.status < 500) return false;
              // Retry once for network errors
              return failureCount < 1;
            },
            onError: (error: any) => {
              // Let components handle specific errors
              if (error instanceof BillingError || error instanceof AgentRunLimitError) {
                return;
              }
              // Global error handler for mutations
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

