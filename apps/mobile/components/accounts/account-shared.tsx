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

import { useAccount, useAccountCapabilities, type AccountCapability } from '@/lib/accounts/hooks';

type AccountCaps = Record<AccountCapability, boolean>;

/**
 * The account plus the current user's capabilities on it, from the IAM probe
 * alone. No role fallback: a slow or failed probe reads as denied, so a
 * control never shows to someone the API would refuse.
 */
export function useEffectiveAccountCaps(accountId: string | null, userId: string | null) {
  const accountQuery = useAccount(accountId);
  const { can } = useAccountCapabilities(accountId, userId);
  return { accountQuery, account: accountQuery.data, can: can as AccountCaps };
}
