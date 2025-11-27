/**
 * App Providers
 * 
 * Wraps the app with all necessary providers:
 * - React Query
 * - Authentication
 * - Internationalization
 * - Agent Management
 * - Advanced Features
 */

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/contexts/AuthContext';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { AgentProvider } from '@/contexts/AgentContext';
import { AdvancedFeaturesProvider } from '@/contexts/AdvancedFeaturesContext';
import { PresenceProvider } from '@/contexts/PresenceContext';

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
        <PresenceProvider>
          <AgentProvider>
            <LanguageProvider>
              <AdvancedFeaturesProvider>
                {children}
              </AdvancedFeaturesProvider>
            </LanguageProvider>
          </AgentProvider>
        </PresenceProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

