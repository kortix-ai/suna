'use client';

/**
 * The account record, read once and shared by the hub page and the settings
 * shell's breadcrumb (which names the account in its middle crumb). One key,
 * one fetcher, one `staleTime` — `branding-tab.tsx` and
 * `member-access-panel.tsx` invalidate this same key after a rename, so both
 * readers refresh together.
 */

import { getAccount } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/features/providers/auth-provider';

export function useAccountDetail(accountId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });
}
