/**
 * The invites pending for the signed-in user's email —
 * `listMyAccountInvites()`, `GET /account-invites`.
 *
 * Read by the `/projects/start` chooser and the workspace switcher, so an
 * invitee who signed up without the email link still finds the workspace or
 * project they were invited to. Same identity gate as `useAccountsList`: no
 * user id, no query, never another user's list.
 */

import { useUiViewerId } from '@kortix/ui/providers/ui-provider';
import { listMyAccountInvites, type MyAccountInvite } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

export function useMyInvites(options: { enabled?: boolean } = {}): UseQueryResult<MyAccountInvite[]> {
  const viewerId = useUiViewerId();
  return useQuery({
    queryKey: qk.accounts.myInvites(viewerId),
    queryFn: listMyAccountInvites,
    enabled: !!viewerId && (options.enabled ?? true),
    staleTime: 30_000,
  });
}
