import { uiRoutes } from '../../lib/routes';
import {
  buildWorkspaceSummaries,
  compareWorkspacesByRecent,
  type AccountInviteLanding,
  type KortixAccount,
  type KortixProject,
  type WorkspaceRole,
  type WorkspaceState,
  type WorkspaceSummary,
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
  /** The caller's one role in the workspace (the C3 ladder). */
  role: WorkspaceRole;
  /** `active`, or a state that takes an action first: `setup_required` (Set
   *  up) or `deleting` (Restore, owners only). */
  state: WorkspaceState;
  /** When a `deleting` workspace is erased. */
  deletionScheduledFor: string | null;
}

/**
 * One row per workspace the API serves (`GET /v1/workspaces`, every state),
 * in the API's order: most recently opened first, then by name. The role and
 * the state are the served ones.
 */
export function workspaceRowsFromSummaries(input: {
  summaries: WorkspaceSummary[];
  accounts: KortixAccount[];
}): WorkspaceRow[] {
  const accountById = new Map(input.accounts.map((account) => [account.account_id, account]));
  const seen = new Set<string>();
  return [...input.summaries]
    .sort(compareWorkspacesByRecent)
    .filter((summary) => (seen.has(summary.workspace_id) ? false : (seen.add(summary.workspace_id), true)))
    .map((summary) => ({
      workspaceId: summary.workspace_id,
      project: summary,
      accountId: summary.account_id,
      accountName: workspaceAccountLabel(accountById.get(summary.account_id)?.name ?? null),
      role: summary.role,
      state: summary.state ?? 'active',
      deletionScheduledFor: summary.deletion_scheduled_for ?? null,
    }));
}

/** "Nov 20, 2026": the day a `deleting` workspace is erased. Empty for no date. */
export function formatWorkspaceDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/** A workspace row the caller can open now. */
export function isOpenableRow(row: WorkspaceRow): boolean {
  return row.state === 'active';
}

export interface ProjectListResult {
  accountId: string;
  data: KortixProject[] | undefined;
  isError: boolean;
}

function roleOf(account: KortixAccount | undefined): WorkspaceRole {
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
        state: 'active' as const,
        deletionScheduledFor: null,
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
 * The newest account the caller OWNS whose project list loaded and holds no
 * active project.
 *
 * @deprecated No create fills an empty account any more: the server makes a
 * new account for every create (`new_workspace: true`, design.md §3.1 items 1
 * and 9), and a GitHub-source create names {@link githubSourceAccount}. Kept
 * for importers of this module.
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
 * {@link reusableEmptyAccount} for a list read from `GET /v1/workspaces`: an
 * owned account none of the served workspaces belongs to.
 *
 * @deprecated See {@link reusableEmptyAccount}.
 */
export function reusableEmptyAccountFromRows(input: {
  accounts: KortixAccount[];
  rows: WorkspaceRow[] | undefined;
}): KortixAccount | null {
  if (!input.rows) return null;
  const used = new Set(input.rows.map((row) => row.accountId));
  const empty = input.accounts.filter((account) => account.account_role === 'owner' && !used.has(account.account_id));
  const created = (account: KortixAccount) => (account.created_at ? new Date(account.created_at).getTime() : 0);
  return [...empty].sort((a, b) => created(b) - created(a))[0] ?? null;
}

/**
 * The account whose GitHub connection a GitHub-source create uses: the
 * account of the first open workspace in `rows` (the API's order, most
 * recently opened first) where the caller is an owner or admin. Those are the
 * roles that manage a workspace's GitHub connection, and the server lets them
 * carry its installation to the new workspace as a grant for one repository
 * (`apps/api/src/projects/routes/byo-new-workspace.ts`). The create names this
 * account as `account_id`; the server decides where the workspace lands (a new
 * account). `null`: no such workspace, so the form offers the managed source
 * only.
 */
export function githubSourceAccount(input: {
  accounts: KortixAccount[];
  rows: WorkspaceRow[] | undefined;
}): KortixAccount | null {
  const row = (input.rows ?? []).find(
    (candidate) => isOpenableRow(candidate) && (candidate.role === 'owner' || candidate.role === 'admin'),
  );
  if (!row) return null;
  return input.accounts.find((account) => account.account_id === row.accountId) ?? null;
}

/**
 * Whether the caller may create a workspace at all: the server's rule. Every
 * create makes a new account, and self-host with
 * `KORTIX_RESTRICT_ACCOUNT_CREATION` refuses a new account to anyone but a
 * platform admin (`403 account_creation_restricted`).
 */
export function canCreateWorkspace(input: {
  restricted: boolean;
  isPlatformAdmin: boolean;
  /** @deprecated Ignored: no create fills an empty account. */
  reusableAccount?: KortixAccount | null;
}): boolean {
  return !input.restricted || input.isPlatformAdmin;
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
    const remembered = all.find((row) => row.workspaceId === input.rememberedProjectId && isOpenableRow(row));
    if (remembered) {
      return { kind: 'open', projectId: remembered.workspaceId, accountId: remembered.accountId };
    }
  }
  // A workspace that waits on Set up or Restore is chosen on the chooser.
  if (all.length === 1 && isOpenableRow(all[0])) {
    return { kind: 'open', projectId: all[0].workspaceId, accountId: all[0].accountId };
  }
  return { kind: 'select' };
}
