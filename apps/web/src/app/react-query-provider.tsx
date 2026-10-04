'use client';

import { useTranslations } from '@/i18n/use-translations';
import { ensureKortixConfigured } from '@/lib/kortix-config';
import { buildQueryClientDefaults } from '@/lib/query-client-defaults';
import { registerQueryClient } from '@/lib/query-client-singleton';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useState } from 'react';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  ensureKortixConfigured(tI18nComplete);
  // The staleTime/gcTime/retry/onError policy lives in
  // lib/query-client-defaults.ts, pinned by lib/query-cache-config.test.ts.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: buildQueryClientDefaults(tI18nComplete) }),
  );
  // Expose the instance so auth-driven resets (logout, cross-account sign-in)
  // and the device caches can reach it from outside the React Query context.
  // Registered here, not inside the initializer: Strict Mode calls an
  // initializer twice and keeps the FIRST result, so registering inside it
  // published the discarded client in development.
  registerQueryClient(queryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_SHOW_DEVTOOLS === '1' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
