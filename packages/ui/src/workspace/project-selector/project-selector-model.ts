import { uiRoutes } from '../../lib/routes';
import {
  buildWorkspaceSummaries,
  compareWorkspacesByRecent,
  type AccountInviteLanding,
  type KortixAccount,
  type KortixProject,
} from '@kortix/sdk';

import { workspaceAccountLabel } from '../sidebar/workspace-grouping';

/**
 * The pure half of every workspace list: the `/workspaces` chooser, the
 * `/workspaces/start` door, the sidebar switcher and the command palette.
 *
 * A workspace is ONE `projects` row and the `accounts` row that owns it — the
 * Slack model (`.agents/skills/learnings/work/workspaces/ux.md`). So the list is
 * flat: one row per project, no account headings. An account with 0 projects
 * is not a workspace and is never listed; a legacy account with several
 * projects shows each project as its own row.
 *
 * Every user state is decided here, from the raw reads (accounts, one project
 * list per account, pending invites):
 *
 *  - new user        — 0 workspaces, 0 invites: create.
 *  - invited         — pending invites, each with Join, above everything.
 *  - returning       — 1+ workspaces: one flat list, most recently opened first.
 */

/** The search field appears once the list stops fitting on one screen. */
export const SEARCH_THRESHOLD = 8;

export interface WorkspaceRow {
  /** The workspace id in every URL (decision D2): the project id. */
  workspaceId: string;
  project: KortixProject;
  accountId: string;
  /** Display-ready — see `workspaceAccountLabel`. Search text only, never a heading. */
  accountName: string;
  /** The caller's role in the owning account. `member` for a project shared
   *  into an account the caller does not belong to. */
  role: NonNullable<KortixAccount['account_role']>;
}

export interface ProjectListResult {
  accountId: string;
  data: KortixProject[] | undefined;
  isError: boolean;
}

function roleOf(account: KortixAccount | undefined): WorkspaceRow['role'] {
  const role = account?.account_role;
  return role === 'owner' || role === 'admin' ? role : 'member';
}

/**
 * One row per active project the caller can open, most recently opened first,
 * then by name. A project whose account is missing from `accounts` (shared into
 * an account the caller is not a member of) still gets a row: the list must
 * never hide a workspace the caller can open. The same project listed by two
 * reads is listed once. The list itself is the SDK's (`buildWorkspaceSummaries`,
 * `compareWorkspacesByRecent`); `role` stays the ACCOUNT role, which the
 * memberships tab writes back as `account_role`.
 */
export function buildWorkspaceRows(input: {
  accounts: KortixAccount[];
  lists: ProjectListResult[];
}): WorkspaceRow[] {
  const accountById = new Map(input.accounts.map((account) => [account.account_id, account]));
  // The row keeps the cached project object itself (same reference as the
  // query data), not the summary copy.
  const projectById = new Map(
    input.lists.flatMap((list) => (list.data ?? []).map((project) => [project.project_id, project] as const)).reverse(),
  );
  return buildWorkspaceSummaries(input)
    .sort(compareWorkspacesByRecent)
    .map((workspace) => {
      const account = accountById.get(workspace.account_id);
      return {
        workspaceId: workspace.workspace_id,
        project: projectById.get(workspace.workspace_id) ?? workspace,
        accountId: workspace.account_id,
        accountName: workspaceAccountLabel(account?.name ?? null),
        role: roleOf(account),
      };
    });
}

/**
 * Case-insensitive, every word required, order irrelevant. Matches the
 * workspace name only: the account is not a separate thing the user sees.
 */
export function filterWorkspaceRows(rows: WorkspaceRow[], query: string): WorkspaceRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = row.project.name.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Accounts whose project list failed: their workspaces are unknown, not absent. */
export function failedAccountIds(lists: ProjectListResult[]): string[] {
  return lists.filter((list) => list.isError).map((list) => list.accountId);
}

/**
 * The account "Create workspace" reuses: the newest account the caller OWNS
 * whose project list loaded and holds no active project. A plan or credits the
 * caller already holds there stay with the new workspace. `null`: the server
 * creates a fresh account (`createWorkspace`, `new_workspace: true`).
 *
 * Ownership is the account role, never `account_id === user_id`: an account a
 * user created explicitly has its own id, and the identity rule locked those
 * users out of creating anything.
 *
 * The server makes the same choice for the managed source. The client needs it
 * only for the GitHub sources, whose installations are account-scoped.
 */
export function reusableEmptyAccount(input: {
  accounts: KortixAccount[];
  lists: ProjectListResult[];
}): KortixAccount | null {
  const listByAccount = new Map(input.lists.map((list) => [list.accountId, list]));
  const empty = input.accounts.filter((account) => {
    if (account.account_role !== 'owner') return false;
    const list = listByAccount.get(account.account_id);
    if (!list || list.isError || !list.data) return false;
    return !list.data.some((project) => project.status !== 'archived');
  });
  if (empty.length === 0) return null;
  const created = (account: KortixAccount) =>
    account.created_at ? new Date(account.created_at).getTime() : 0;
  return [...empty].sort((a, b) => created(b) - created(a))[0] ?? null;
}

/**
 * Whether the caller may create a workspace at all.
 *
 * Self-host with `KORTIX_RESTRICT_ACCOUNT_CREATION` refuses a new account to
 * anyone but a platform admin (`account_creation_restricted`, 403). A caller
 * who already owns an empty account can still fill it, because that create
 * makes no account.
 */
export function canCreateWorkspace(input: {
  restricted: boolean;
  isPlatformAdmin: boolean;
  reusableAccount: KortixAccount | null;
}): boolean {
  return !input.restricted || input.isPlatformAdmin || input.reusableAccount !== null;
}

/**
 * The route of an invite landing (KRTX-1731). `accountInviteLanding` in the
 * SDK decides where an accepted invite lands, for every host: the invited
 * project, or the joined account. An account lands on the door for that
 * account; the plain door reopened the project this browser remembered, in
 * the account the user came from.
 */
export function inviteLandingPath(landing: AccountInviteLanding): string {
  return landing.kind === 'project'
    ? uiRoutes().project(landing.projectId)
    : `/workspaces/start?account=${encodeURIComponent(landing.accountId)}`;
}

/**
 * `/workspaces/start` — open a workspace directly, or show the chooser.
 *
 * The chooser is skipped only when there is exactly one obvious answer:
 *  - the workspace the browser last had open still exists, or
 *  - the user has exactly one workspace.
 * A pending invite always shows the chooser, so an invite is never skipped
 * past on the way into a workspace.
 *
 * `requestedAccountId` (`/workspaces/start?account=<id>`, after an invite
 * accept) bounds both answers to that account, and wins over a pending
 * invite: the user just chose where to go (KRTX-1731).
 */
export type DoorDecision =
  | { kind: 'open'; projectId: string; accountId: string }
  | { kind: 'select' };

export function decideDoor(input: {
  workspaces: WorkspaceRow[];
  inviteCount: number;
  rememberedProjectId: string | null;
  requestedAccountId?: string | null;
}): DoorDecision {
  const requested = input.requestedAccountId ?? null;
  if (input.inviteCount > 0 && !requested) return { kind: 'select' };
  const all = input.workspaces.filter((row) => !requested || row.accountId === requested);
  if (input.rememberedProjectId) {
    const remembered = all.find((row) => row.workspaceId === input.rememberedProjectId);
    if (remembered) {
      return { kind: 'open', projectId: remembered.workspaceId, accountId: remembered.accountId };
    }
  }
  if (all.length === 1) {
    return { kind: 'open', projectId: all[0].workspaceId, accountId: all[0].accountId };
  }
  return { kind: 'select' };
}
