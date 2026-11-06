'use client';

import { workspaceAccountLabel } from '@kortix/ui/workspace/sidebar/workspace-grouping';

/**
 * Every workspace the signed-in user belongs to, each linking to that
 * workspace's settings (`/workspaces/<id>/admin`). A workspace is one account
 * and its project, so this is one row per workspace (Workspaces ux.md); an
 * account with no project is not a workspace and is not listed.
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
 * **Why `/workspaces/<id>/admin` with no section.** It opens General, else the
 * first section the caller may open — the same destination as the switcher's
 * "Workspace settings" row: one link in the product, one target.
 *
 * **Why no empty state and no error state.** A user with no workspace has
 * nothing to manage here, and the chooser is where they create or join one;
 * so this renders nothing rather than an empty box. A failed fetch takes the
 * same path: this is a shortcut to a page reachable from the sidebar switcher
 * too, so a red banner inside a profile pane would cost more than it is worth.
 */

import { Button } from '@kortix/ui/button';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { SettingsSubsectionHeader } from '@kortix/ui/settings-subsection-header';
import { Skeleton } from '@kortix/ui/skeleton';
import { HubLink } from '@kortix/ui/internal/account-hub/account-hub-location';
import { hubTarget } from '@kortix/ui/internal/stores/account-panel-store';
import { useWorkspaceDirectory } from '@kortix/ui/workspace/sidebar/use-workspace-directory';
import { type KortixAccount } from '@kortix/sdk';
import Link from 'next/link';

/** Exactly the fields this list reads — nothing else from `KortixAccount`. */
export type AccountMembership = Pick<KortixAccount, 'account_id' | 'name' | 'account_role'> & {
  /** The workspace's id: the row links to its settings. Absent: the account hub link. */
  workspace_id?: string;
};

export interface AccountMembershipsCopy {
  title: string;
  description: string;
  fallbackAccountName: string;
  owner: string;
  admin: string;
  member: string;
  manage: string;
}

export const DEFAULT_ACCOUNT_MEMBERSHIPS_COPY: AccountMembershipsCopy = {
  title: 'Workspaces',
  description: "Members, billing, roles, and audit live in each workspace's own settings.",
  fallbackAccountName: 'Workspace',
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  manage: 'Manage',
};

/**
 * The row's second line: the caller's role in that account.
 *
 * `GET /accounts` always sends one of `owner` / `admin` / `member`
 * (`api/src/accounts/core/accounts.ts:106`), but the SDK types it optional, so
 * an absent or unrecognized value returns `undefined` and the row renders with
 * no description rather than the literal string it was handed.
 */
export function accountRoleLabel(
  role: string | null | undefined,
  copy: AccountMembershipsCopy = DEFAULT_ACCOUNT_MEMBERSHIPS_COPY,
): string | undefined {
  switch (role) {
    case 'owner':
      return copy.owner;
    case 'admin':
      return copy.admin;
    case 'member':
      return copy.member;
    default:
      return undefined;
  }
}

export interface AccountMembershipsSectionProps {
  accounts?: readonly AccountMembership[];
  isLoading?: boolean;
  copy?: AccountMembershipsCopy;
}

/**
 * Presentational only — no query, no router. Rendered directly by
 * `ProfileTabView`, which is itself hook-free so it renders under
 * `renderToStaticMarkup` (see `profile-tab.test.tsx`).
 */
export function AccountMembershipsSection({
  accounts = [],
  isLoading = false,
  copy = DEFAULT_ACCOUNT_MEMBERSHIPS_COPY,
}: AccountMembershipsSectionProps) {
  // Nothing, not a heading over an empty box — see this file's header.
  if (!isLoading && accounts.length === 0) return null;

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={copy.title} description={copy.description} />

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
              label={workspaceAccountLabel(account.name, copy.fallbackAccountName, false)}
              description={accountRoleLabel(account.account_role, copy)}
            >
              <Button asChild variant="outline" size="sm">
                {account.workspace_id ? (
                  <Link href={`/workspaces/${account.workspace_id}/admin`}>{copy.manage}</Link>
                ) : (
                  <HubLink to={hubTarget(account.account_id)}>{copy.manage}</HubLink>
                )}
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsRowGroup>
    </section>
  );
}

/**
 * The workspaces the user belongs to, one row each.
 *
 * Reads through `useWorkspaceDirectory()`, the switcher's and the chooser's
 * list, so opening this pane costs no request once either has loaded.
 */
export function useAccountMemberships(): { accounts: AccountMembership[]; isLoading: boolean } {
  const directory = useWorkspaceDirectory();
  return {
    accounts: directory.workspaces.map((row) => ({
      account_id: row.accountId,
      name: row.project.name,
      account_role: row.role,
      workspace_id: row.workspaceId,
    })),
    isLoading: directory.loading,
  };
}
