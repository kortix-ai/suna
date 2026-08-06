'use client';

import '@/lib/kortix-config'; // configure @kortix/sdk before any data-layer call
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { handleApiError } from '@/lib/error-handler';
import { registerQueryClient } from '@/lib/query-client-singleton';

import { isBillingError } from '@kortix/sdk/react';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
        defaultOptions: {
          queries: {
            // Default staleTime increased from 20s to 5min. Most data is kept
            // fresh by SSE events — the staleTime just prevents unnecessary
            // background refetches when components remount. SSE-driven hooks
            // override this to Infinity. Non-SSE hooks (files, billing, etc.)
            // set their own shorter staleTime as needed.
            staleTime: 5 * 60 * 1000,
            // gcTime must strictly EXCEED staleTime. Set equal (both 5 min, as
            // they were), an entry with no mounted observer is garbage
            // collected at the exact instant it goes stale, so React Query can
            // never serve stale content while revalidating — every return
            // visit past the window is a cold fetch and a skeleton.
            //
            // 30 min is chosen to outlast a working session, not a workday.
            // Cost is a few hundred KB of JSON; the payoff is that revisiting
            // any surface inside a session renders from cache.
            gcTime: 30 * 60 * 1000,
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
              // Transient "opencode not ready" 503 surfaces while a sandbox is
              // still booting its opencode binary. The auto-create + SDK call
              // sites already retry internally; surfacing this as a user toast
              // is just noise during the boot window. Suppress it.
              const msg = typeof error?.message === 'string' ? error.message : '';
              if (/opencode not ready/i.test(msg)) {
                return;
              }
              handleApiError(error, {
                operation: 'perform action',
                silent: false,
              });
            },
          },
        },
      });
    // Expose the instance so auth-driven resets (logout, cross-account
    // sign-in) can clear the cache from outside the React Query context.
    registerQueryClient(client);
    return client;
  });

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
