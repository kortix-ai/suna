'use client';

/**
 * The account member list, read once and shared by the hub page (the Members
 * pane) and the settings sidebar (the count beside "Members"). One key, one
 * fetcher, one gate — two hand-typed copies is how a "13 readers, one
 * request" property quietly becomes two requests (see
 * `hooks/account/use-accounts-list.ts` for the longer version of that story).
 */

import { listAccountMembers } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/features/providers/auth-provider';

export function useAccountMembers(accountId: string | undefined, canReadMembers: boolean) {
  const { user } = useAuth();
  // `GET .../iam/members` asserts `member.read`, so hold the request until the
  // probe stops saying no. `!== false` (not `=== true`) keeps it optimistic:
  // the list still starts loading the moment the probe answers, and an
  // in-flight probe never delays it for someone who does have the leaf.
  return useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId!),
    enabled: !!user && !!accountId && canReadMembers !== false,
    staleTime: 20_000,
  });
}
