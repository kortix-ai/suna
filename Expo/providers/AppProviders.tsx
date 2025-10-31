/**
 * App Providers
 *
 * Wraps the app with all necessary providers:
 * - React Query
 * - Authentication
 * - Internationalization
 * - Billing
 */

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/contexts/AuthContext';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { BillingProvider } from '@/contexts/BillingContext';

interface AppProvidersProps {
  children: React.ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  // Initialize QueryClient inline (modern React Query pattern)
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 2,
        staleTime: 5 * 60 * 1000, // 5 minutes
        refetchOnWindowFocus: false,
      },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BillingProvider>
          <LanguageProvider>
            {children}
          </LanguageProvider>
        </BillingProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

