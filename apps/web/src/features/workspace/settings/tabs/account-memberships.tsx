'use client';

/**
 * Every organization the signed-in user belongs to, each linking to that
 * account's own settings.
 *
 * **Why it lives on the Profile tab and not in its own rail row** (Jay,
 * 2026-08-17: "in the user settings also have all the accounts you're a part of
 * so you can easily go to the account settings as well from the user
 * settings"). The panel is a 896×660 dialog with three rail rows, and this list
 * is one row per account — a user in one account sees a single row, a user in
 * three sees three. A fourth rail row for that would be a tab you must find
 * before you can read two lines, and it would compete with "Connected accounts"
 * for the same word. Profile already opens by default (`DEFAULT_SETTINGS_TAB`)
 * and already answers "who am I" — email, display name, second factor. Which
 * organizations that identity is a member of is the same question, so it sits
 * with them, ABOVE Security and Danger zone: it is the row a person came here
 * to click, and Jay asked for "easily", which means no scrolling and no tab
 * hunt.
 *
 * **Why `/accounts/<id>` with no `?tab=`.** That page's `VALID_TABS` falls back
 * to `members` (`app/(app)/accounts/[id]/page.tsx:349`), which is the section a
 * reader arriving from "which organizations am I in" is asking about. Same
 * destination the workspace switcher's "Account settings" row and the Members
 * pane's "Organization account settings" row already use — one account link in
 * the product, one target.
 *
 * **Why no empty state and no error state.** A signed-in user always has at
 * least one account: `GET /accounts` bootstraps a personal one when the
 * membership query comes back empty (`api/src/accounts/core/accounts.ts:112`).
 * So "zero accounts" is not a state a user reaches — it only means the query
 * has not answered — and this renders nothing at all rather than asserting an
 * emptiness it cannot observe. A failed fetch takes the same path for the same
 * reason: this is a shortcut to a page reachable from the sidebar switcher too,
 * not the only door to it, so a red banner inside a profile pane would cost
 * more attention than the shortcut is worth.
 */

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { type KortixAccount } from '@kortix/sdk';

import { useAccountsList } from '@/hooks/account/use-accounts-list';

/** Exactly the fields this list reads — nothing else from `KortixAccount`. */
export type AccountMembership = Pick<KortixAccount, 'account_id' | 'name' | 'account_role'>;

/** Matches `workspace-grouping.ts`'s fallback: a row never renders blank. */
const FALLBACK_ACCOUNT_NAME = 'Account';

/**
 * The row's second line: the caller's role in that account.
 *
 * `GET /accounts` always sends one of `owner` / `admin` / `member`
 * (`api/src/accounts/core/accounts.ts:106`), but the SDK types it optional, so
 * an absent or unrecognized value returns `undefined` and the row renders with
 * no description rather than the literal string it was handed.
 */
export function accountRoleLabel(role: string | null | undefined): string | undefined {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    default:
      return undefined;
  }
}

export interface AccountMembershipsSectionProps {
  accounts?: readonly AccountMembership[];
  isLoading?: boolean;
}

/**
 * Presentational only — no query, no router. Rendered directly by
 * `ProfileTabView`, which is itself hook-free so it renders under
 * `renderToStaticMarkup` (see `profile-tab.test.tsx`).
 */
export function AccountMembershipsSection({
  accounts = [],
  isLoading = false,
}: AccountMembershipsSectionProps) {
  // Nothing, not a heading over an empty box — see this file's header.
  if (!isLoading && accounts.length === 0) return null;

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title="Organizations"
        description="Members, billing, roles, and audit live in each organization's own settings."
      />

      <SettingsRowGroup>
        {isLoading ? (
          /* One shape-matched row, so the section does not grow by a row's
             height the moment the list lands. `h-8` is the `size="sm"` button
             each real row carries on the right. */
          <div className="px-4 py-3">
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        ) : (
          accounts.map((account) => (
            <SettingsRow
              key={account.account_id}
              label={account.name?.trim() || FALLBACK_ACCOUNT_NAME}
              description={accountRoleLabel(account.account_role)}
            >
              <Button asChild variant="outline" size="sm">
                <Link href={`/accounts/${account.account_id}`}>Manage</Link>
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsRowGroup>
    </section>
  );
}

/**
 * The accounts the user belongs to.
 *
 * Reads through `useAccountsList()`, the one definition of that query, so this
 * pane, `use-ensure-selected-account.ts` and `workspace-menu-section.tsx` all
 * share one user-scoped cache entry — opening this pane inside a project shell
 * costs no request at all, because `WorkspaceSwitcher` already primed that
 * entry on mount.
 */
export function useAccountMemberships(): { accounts: AccountMembership[]; isLoading: boolean } {
  const query = useAccountsList();
  return { accounts: query.data ?? [], isLoading: query.isLoading };
}
