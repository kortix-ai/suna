/**
 * switcher — pure decision logic for the workspace switcher
 * (`components/projects/ProjectSwitcherSheet.tsx`) and the Workspaces page
 * (`app/projects/index.tsx`): the flat workspace list, the search filter, and
 * the route a workspace opens at.
 *
 * A workspace is one project and the account that owns it (the Slack model,
 * `.agents/skills/learnings/work/workspaces/ux.md`). The list is flat: no
 * account headings. A legacy account with several projects shows each
 * project as its own row. An account with 0 projects is not a workspace and
 * adds no row.
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';

/** One workspace row: the project (its id is the workspace id) and the account that owns it. */
export interface WorkspaceRow {
  project: KortixProject;
  account: KortixAccount;
  /** `active`, or a state that takes an action first: Set up, or Restore (owners). */
  state?: 'active' | 'setup_required' | 'deleting';
  /** When a `deleting` workspace is erased. */
  deletionScheduledFor?: string | null;
  /** The caller's one role in the workspace (owner > admin > manager > member). */
  role?: 'owner' | 'admin' | 'manager' | 'member';
}

/** The served list (`GET /v1/workspaces`, every state) as rows; `accounts` names each owner account. */
export function workspaceRowsFromServed(
  accounts: KortixAccount[],
  served: ReadonlyArray<
    KortixProject & {
      state?: WorkspaceRow['state'];
      deletion_scheduled_for?: string | null;
      role?: WorkspaceRow['role'];
    }
  >,
): WorkspaceRow[] {
  const byId = new Map(accounts.map((account) => [account.account_id, account]));
  return served.map((project) => ({
    project,
    account: byId.get(project.account_id) ?? ({ account_id: project.account_id, name: project.name } as KortixAccount),
    state: project.state ?? 'active',
    deletionScheduledFor: project.deletion_scheduled_for ?? null,
    role: project.role,
  }));
}

/** A row that opens now. Set up and Restore come first for the others. */
export function isOpenableWorkspaceRow(row: WorkspaceRow): boolean {
  return (row.state ?? 'active') === 'active';
}

/**
 * Every workspace of the user, one row per project, in the server's account
 * order and each account's project order. `lists` holds each account's
 * loaded project list; an account without a loaded list adds nothing.
 */
export function workspaceRows(
  accounts: KortixAccount[],
  lists: ReadonlyMap<string, KortixProject[] | undefined>
): WorkspaceRow[] {
  return accounts.flatMap((account) =>
    (lists.get(account.account_id) ?? []).map((project) => ({ project, account }))
  );
}

/** The Workspaces page shows its search control at this many rows or more (ux.md: "Search appears at 8+ rows"). */
export const WORKSPACE_PAGE_SEARCH_MIN_ROWS = 8;

export function shouldShowWorkspacePageSearch(rowCount: number): boolean {
  return rowCount >= WORKSPACE_PAGE_SEARCH_MIN_ROWS;
}

/** Case-insensitive, trimmed substring match on the workspace name. */
export function filterWorkspaceRows(rows: WorkspaceRow[], query: string): WorkspaceRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => row.project.name.toLowerCase().includes(q));
}

/**
 * The route a workspace opens at — shared by the switcher sheet and the
 * Workspaces page (`router.replace`). expo-router's typed routes need the
 * dynamic segment as `params`, not interpolated into `pathname`, so this
 * returns the `Href` shape directly rather than a path string.
 */
export interface ProjectHref {
  pathname: '/projects/[id]';
  params: { id: string };
}

export function projectHref(projectId: string): ProjectHref {
  return { pathname: '/projects/[id]', params: { id: projectId } };
}
