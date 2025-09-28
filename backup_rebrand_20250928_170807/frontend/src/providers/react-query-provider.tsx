'use client';

import { useState } from 'react';
import {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { handleApiError } from '@/lib/error-handler';
import { isLocalMode } from '@/lib/config';
import { BillingError, AgentRunLimitError } from '@/lib/api';

export function ReactQueryProvider({
  children,
  dehydratedState,
}: {
  children: React.ReactNode;
  dehydratedState?: unknown;
}) {
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
            onError: (error: any, variables: any, context: any) => {
              // Don't globally handle errors that are expected to be handled by components
              if (error instanceof BillingError || error instanceof AgentRunLimitError) {
                return; // Let components handle these specific errors
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

  const isLocal = isLocalMode();

  return (
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydratedState}>
        {children}
        {isLocal && (
          <ReactQueryDevtools initialIsOpen={false} />
        )}
      </HydrationBoundary>
    </QueryClientProvider>
  );
}
