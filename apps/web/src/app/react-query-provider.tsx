'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { handleApiError } from '@/lib/error-handler';

import { isBillingError } from '@/lib/api/errors';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Default staleTime increased from 20s to 5min. Most data is kept
            // fresh by SSE events — the staleTime just prevents unnecessary
            // background refetches when components remount. SSE-driven hooks
            // override this to Infinity. Non-SSE hooks (files, billing, etc.)
            // set their own shorter staleTime as needed.
            staleTime: 5 * 60 * 1000,
            gcTime: 5 * 60 * 1000,
            // Enable request deduplication - React Query will batch simultaneous requests
            structuralSharing: true,
            // Deduplicate requests within 1000ms window (default)
            retry: (failureCount, error: any) => {
              if (error?.status >= 400 && error?.status < 500) return false;
              if (error?.status === 404) return false;
              return failureCount < 3;
            },
            // With staleTime: 5min+, refetchOnMount is unnecessary — data is
            // already fresh from boot or SSE events. Hooks that need fresh-on-mount
            // data (e.g. billing) override this per-query.
            refetchOnMount: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
          mutations: {
            retry: (failureCount, error: any) => {
              if (error?.status >= 400 && error?.status < 500) return false;
              return failureCount < 1;
            },
            onError: (error: any) => {
              // Billing errors are handled by the error handler (opens pricing modal)
              // Don't show generic toast for them
              if (isBillingError(error)) {
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
      {process.env.NODE_ENV === 'development' &&
        process.env.NEXT_PUBLIC_SHOW_DEVTOOLS === '1' && (
          <ReactQueryDevtools initialIsOpen={false} />
        )}
    </QueryClientProvider>
  );
}
