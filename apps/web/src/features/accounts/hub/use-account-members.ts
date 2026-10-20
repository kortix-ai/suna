'use client';

/**
 * The account member list, read once and shared by the hub page (the Members
 * pane) and the settings sidebar (the count beside "Members"). One key, one
 * fetcher, one gate — two hand-typed copies is how a "13 readers, one
 * request" property quietly becomes two requests (see
 * `hooks/account/use-accounts-list.ts` for the longer version of that story).
 */

import { listAccountMembers } from '@kortix/sdk';
import { contract } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/features/providers/auth-provider';

export function useAccountMembers(accountId: string | undefined) {
  const { user } = useAuth();
  // `GET .../members` answers every account member: the whole directory with
  // `member.read`, else only the caller. No probe to
  // wait for.
  return useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId!),
    enabled: !!user && !!accountId,
    ...contract('directory'),
  });
}
