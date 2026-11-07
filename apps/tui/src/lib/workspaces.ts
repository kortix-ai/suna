/**
 * Workspaces: the one top-level thing the TUI lets a person pick.
 *
 * A workspace is one project and the account that owns it. The workspace id
 * is the `project_id`. An account with no project is not a workspace and is
 * never listed. A legacy account with several projects shows each project as
 * its own workspace. There is no separate account picker.
 *
 * The rows come from the SDK's own reads (`useAccounts`, and one
 * `projectsQueryOptions(accountId)` query per account), so every reader shares
 * the SDK cache entries that `useProjects(accountId)` uses.
 */

import type { KortixAccount, KortixProject } from '@kortix/sdk';
import { projectsQueryOptions, useAccounts } from '@kortix/sdk/react';
import { useQueries } from '@tanstack/react-query';

import { kortix } from '../kortix.ts';

/** What every surface says when the person has no workspace. Same text as the CLI. */
export const NO_WORKSPACE_TEXT =
  'No workspace yet. Create one with kortix workspaces create <name>, or accept an invite.';

/** What a surface says when the person has workspaces but none is open. */
export const PICK_WORKSPACE_TEXT = 'No workspace open. Type /workspaces to pick one.';

export interface WorkspaceRow {
  /** The workspace id: the `project_id`. */
  id: string;
  accountId: string;
  name: string;
}

/**
 * One flat row per project, in account order, then project order. Accounts
 * without a project contribute nothing. A project id seen twice is listed once.
 */
export function workspaceRows(
  accounts: readonly Pick<KortixAccount, 'account_id'>[],
  projectsByAccount: ReadonlyMap<string, readonly Pick<KortixProject, 'project_id' | 'account_id' | 'name'>[]>,
): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    for (const project of projectsByAccount.get(account.account_id) ?? []) {
      if (seen.has(project.project_id)) continue;
      seen.add(project.project_id);
      rows.push({
        id: project.project_id,
        accountId: project.account_id || account.account_id,
        name: project.name || project.project_id.slice(0, 8),
      });
    }
  }
  return rows;
}

export interface WorkspacesState {
  rows: WorkspaceRow[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

/** Every workspace the signed-in person can open, as one flat list. */
export function useWorkspaces(): WorkspacesState {
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  const projectQueries = useQueries({
    queries: accounts.map((account) => ({
      ...projectsQueryOptions(account.account_id),
      queryFn: () => kortix().projects.listForAccount(account.account_id) as Promise<KortixProject[]>,
    })),
  });
  const projectsByAccount = new Map<string, readonly KortixProject[]>();
  accounts.forEach((account, index) => {
    projectsByAccount.set(account.account_id, projectQueries[index]?.data ?? []);
  });
  const rows = workspaceRows(accounts, projectsByAccount);
  const failed = accountsQuery.isError ? accountsQuery : projectQueries.find((query) => query.isError);
  return {
    rows,
    isLoading: accountsQuery.isLoading || projectQueries.some((query) => query.isLoading),
    isError: Boolean(failed),
    error: failed?.error ?? null,
  };
}
