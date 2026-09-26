/**
 * Shared pieces for the account screens (`/accounts/[id]`).
 *
 * `useEffectiveAccountCaps` gates the web-handoff rows on `/accounts/[id]`.
 * The role pickers, member/group detail helpers, the legacy card / pill /
 * uppercase label / skeleton primitives, and the `NewAccountSheet` pieces
 * were deleted once no screen imported them (see apps/mobile/design.md —
 * mobile hands Members, Git and Audit off to web, COR-120; accounts are
 * created on the web, KRTX-246).
 */

import { useMemo } from 'react';
import { useAccount, useAccountCapabilities, type AccountCapability } from '@/lib/accounts/hooks';

export type AccountCaps = Record<AccountCapability, boolean>;

/**
 * The account plus the current user's capabilities on it. The IAM probe is
 * merged with the account role so owners/admins keep full access even if the
 * probe is slow or unavailable (it can't *remove* a granted capability).
 */
export function useEffectiveAccountCaps(accountId: string | null, userId: string | null) {
  const accountQuery = useAccount(accountId);
  const { can } = useAccountCapabilities(accountId, userId);
  const account = accountQuery.data;
  const isAdmin = account?.role === 'owner' || account?.role === 'admin';
  const isOwner = account?.role === 'owner';
  const effectiveCan = useMemo<AccountCaps>(
    () => ({
      'account.write': can['account.write'] || isAdmin,
      'account.delete': can['account.delete'] || isOwner,
      'member.invite': can['member.invite'] || isAdmin,
      'member.remove': can['member.remove'] || isAdmin,
      'member.update': can['member.update'] || isAdmin,
      'group.create': can['group.create'] || isAdmin,
      'audit.read': can['audit.read'] || isAdmin,
    }),
    [can, isAdmin, isOwner]
  );
  return { accountQuery, account, can: effectiveCan };
}
