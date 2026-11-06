'use client';

import { workspaceAccountLabel } from '@kortix/ui/workspace/sidebar/workspace-grouping';

/**
 * Every workspace the signed-in user belongs to: the Preferences rail lists
 * them (`settings-rail.tsx`), each row closing the dialog on its way to that
 * workspace's settings. A workspace is one account and its project (Workspaces
 * ux.md); an account with no project is not listed. The Profile tab carried a
 * second copy of this list until finding 37: one list, one behavior.
 */

import { useWorkspaceDirectory } from '@kortix/ui/workspace/sidebar/use-workspace-directory';
import { type KortixAccount } from '@kortix/sdk';

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


/**
 * The workspaces the user belongs to, one row each.
 *
 * Reads through `useWorkspaceDirectory()`, the switcher's and the chooser's
 * list, so opening this pane costs no request once either has loaded.
 */
export function useAccountMemberships(): { accounts: AccountMembership[]; isLoading: boolean } {
  const directory = useWorkspaceDirectory();
  return {
    accounts: directory.openable.map((row) => ({
      account_id: row.accountId,
      name: row.project.name,
      account_role: row.role,
      workspace_id: row.workspaceId,
    })),
    isLoading: directory.loading,
  };
}
