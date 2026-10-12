/**
 * The caller's own invites (KRTX-1731): the pending list (the start screen and
 * the switcher sheet) and one invite's description (`app/invites/[id].tsx`).
 * Neither key is persisted (lib/query/persisted-queries.ts): an invite's state
 * changes on another device.
 */
import { useQuery } from '@tanstack/react-query';

import { describeAccountInvite, listMyAccountInvites } from '@/lib/accounts/accounts-client';

export const inviteKeys = {
  mine: ['account-invites-mine'] as const,
  invite: (inviteId: string) => ['account-invite', inviteId] as const,
};

export function useMyInvites(enabled: boolean) {
  return useQuery({ queryKey: inviteKeys.mine, queryFn: listMyAccountInvites, enabled });
}

export function useInvite(inviteId: string, enabled: boolean) {
  return useQuery({
    queryKey: inviteKeys.invite(inviteId),
    queryFn: () => describeAccountInvite(inviteId),
    enabled,
    // A 404 stays a 404; every visit reads the invite's current state.
    retry: false,
    staleTime: 0,
  });
}
