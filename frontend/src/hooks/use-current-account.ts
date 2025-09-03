'use client';

import { useMemo, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAccounts } from './use-accounts';

export interface CurrentAccount {
  account_id: string;
  name: string;
  personal_account: boolean;
  slug?: string;
  is_team_context: boolean;
}

const TEAM_CONTEXT_KEY = 'current_team_context';

/**
 * Hook to determine the current account context based on URL path
 * Returns the appropriate account_id for API calls
 */
export function useCurrentAccount(): CurrentAccount | null {
  const pathname = usePathname();
  const { data: accounts } = useAccounts();

  useEffect(() => {
    // Store current team context in sessionStorage when on team pages
    if (pathname && accounts) {
      const teamMatch = pathname.match(/^\/([^\/]+)(?:\/|$)/);
      const teamSlug = teamMatch?.[1];
      
      if (teamSlug && teamSlug !== 'dashboard') {
        const teamAccount = accounts.find(
          (account) => !account.personal_account && account.slug === teamSlug
        );
        
        if (teamAccount) {
          sessionStorage.setItem(TEAM_CONTEXT_KEY, JSON.stringify({
            account_id: teamAccount.account_id,
            name: teamAccount.name,
            slug: teamAccount.slug,
            timestamp: Date.now()
          }));
        }
      }
    }
  }, [pathname, accounts]);

  return useMemo(() => {
    if (!accounts) return null;

    // Extract team slug from URL path
    const teamMatch = pathname?.match(/^\/([^\/]+)(?:\/|$)/);
    const teamSlug = teamMatch?.[1];

    // Skip if it's a known non-team route
    const contextAwareRoutes = ['agents', 'projects', 'settings', 'marketplace', 'meetings', 'dashboard']; // Routes that should respect team context
    const nonTeamRoutes = ['api', 'auth', 'legal', 'share', 'invitation', 'monitoring'];
    
    if (!teamSlug || nonTeamRoutes.includes(teamSlug)) {
      // Default to personal account for pure non-team routes
      const personalAccount = accounts.find((account) => account.personal_account);
      
      if (personalAccount) {
        return {
          account_id: personalAccount.account_id,
          name: personalAccount.name,
          personal_account: true,
          slug: personalAccount.slug,
          is_team_context: false,
        };
      }
      return null;
    }

    // For context-aware routes (agents, dashboard, etc.), check for stored team context
    if (contextAwareRoutes.includes(teamSlug)) {
      try {
        const storedContext = sessionStorage.getItem(TEAM_CONTEXT_KEY);
        if (storedContext) {
          const context = JSON.parse(storedContext);
          const fiveMinutesAgo = Date.now() - (5 * 60 * 1000); // 5 minutes
          
          // If team context was stored recently (within 5 minutes), use it
          if (context.timestamp > fiveMinutesAgo) {
            const teamAccount = accounts.find(
              (account) => !account.personal_account && account.account_id === context.account_id
            );
            
            if (teamAccount) {
              return {
                account_id: teamAccount.account_id,
                name: teamAccount.name,
                personal_account: false,
                slug: teamAccount.slug,
                is_team_context: true,
              };
            }
          }
        }
      } catch (error) {
        console.warn('Failed to read team context from sessionStorage:', error);
      }
      
      // Default to personal account if no recent team context
      const personalAccount = accounts.find((account) => account.personal_account);
      
      if (personalAccount) {
        return {
          account_id: personalAccount.account_id,
          name: personalAccount.name,
          personal_account: true,
          slug: personalAccount.slug,
          is_team_context: false,
        };
      }
      return null;
    }



    // Check if this slug matches a team account
    const teamAccount = accounts.find(
      (account) => !account.personal_account && account.slug === teamSlug
    );
    
    if (teamAccount) {
      return {
        account_id: teamAccount.account_id,
        name: teamAccount.name,
        personal_account: false,
        slug: teamAccount.slug,
        is_team_context: true,
      };
    }

    // If no team found, default to personal account
    const personalAccount = accounts.find((account) => account.personal_account);
    
    if (personalAccount) {
      return {
        account_id: personalAccount.account_id,
        name: personalAccount.name,
        personal_account: true,
        slug: personalAccount.slug,
        is_team_context: false,
      };
    }

    return null;
  }, [pathname, accounts]);
} 