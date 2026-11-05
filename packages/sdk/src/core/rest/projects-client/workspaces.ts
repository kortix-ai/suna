// Workspaces — the one top-level Kortix entity (the Slack model).
//
// A workspace is one company's Kortix: members, roles, billing, secrets,
// agents, sessions. Physically it is one `accounts` row (directory, billing,
// settings) and its one `projects` row (name, config repository). The public
// workspace id, `workspace_id`, IS the project id: every session URL, SDK
// call and `KORTIX_PROJECT_ID` already carries it. The account id stays the
// internal billing and directory key.
//
// The older `Project*` / `Account*` names keep working permanently. Use the
// `Workspace*` names in new code.
//
// NOT the sandbox file tree. `RuntimeWorkspace*`, `useRuntimeWorkspace`, the
// `./workspace-search` subpath, `toWorkspaceRelative` and `normalizeWorkspacePath`
// mean the session sandbox's `/workspace` directory. `CaptureWorkspace` is a
// Kortix Capture tenant. Neither is a Kortix workspace.
//
// Routes: these functions call `/projects/:id` and `/accounts/:accountId/*`
// today and resolve the workspace's account themselves. When the API serves
// `/v1/workspaces/:workspaceId/*`, only the paths below change; every
// signature and response type stays.

import { ApiError, type ApiClientOptions, backendApi } from '../../http/api-client';
import {
  type AccountBranding,
  type AccountDetail,
  type AccountInvitation,
  type AccountMember,
  type InviteMemberResult,
  type InviteProjectGrant,
  type KortixAccount,
  type ResendInviteResult,
  cancelAccountInvite,
  inviteAccountMember,
  leaveAccount,
  listAccountInvites,
  listAccountMembers,
  listAccounts,
  removeAccountMember,
  resendAccountInvite,
  updateAccountMemberRole,
} from './accounts';
import {
  type AssignmentInput,
  type ListAssignmentsFilter,
  createAssignment,
  listAssignments,
  revokeAssignment,
} from './assignments';
import { type GetAccountStateOptions, getAccountState } from './billing';
import { listGroups } from './iam-groups';
import {
  type PermissionProbeInput,
  probeEffectivePermission,
  probeEffectivePermissions,
} from './iam-probe';
import { listRoles } from './iam-roles';
import {
  type KortixProject,
  type ProjectInput,
  getProject,
  listProjectsForAccount,
  updateProject,
} from './projects';
import type { AccountRole, ProjectRole } from './shared';
import {
  type CreateAccountTokenInput,
  type ListAccountTokensOptions,
  createAccountToken,
  listAccountTokens,
  revokeAccountToken,
} from './tokens';

/**
 * The caller's role in a workspace. `owner` and `admin` administer it
 * (members, billing, SSO, keys). `manager` manages its agents, skills and
 * sessions. `member` reads and runs.
 */
export type WorkspaceRole = 'owner' | 'admin' | 'manager' | 'member';

/**
 * One workspace in a list: the workspace's row plus its id and the caller's
 * role. It carries every `KortixProject` field, so it works wherever a
 * `KortixProject` is expected.
 */
export interface WorkspaceSummary extends KortixProject {
  /** The workspace id: the same value as `project_id`. Use it in every URL and call. */
  workspace_id: string;
  /** The caller's role in this workspace. */
  role: WorkspaceRole;
}

/**
 * The workspace's own settings. Absent when the caller may not read them
 * (a person with access to the workspace's agents but no workspace
 * membership) or the server is older than the field.
 */
export interface WorkspaceSettings {
  /** Every member must have a verified MFA factor. */
  mfa_required?: boolean;
  /** Effective branding: the stored record when the plan allows it, else `null`. */
  branding?: AccountBranding | null;
  /** People in the workspace. */
  member_count?: number;
  /** When the setup wizard finished; `null` while it runs. */
  setup_complete_at?: string | null;
  session_max_lifetime_minutes?: number | null;
  session_idle_timeout_minutes?: number | null;
  pat_max_lifetime_days?: number | null;
  pat_require_expiry?: boolean;
  pat_idle_revoke_days?: number | null;
  /** Owners and admins see every member's sessions. */
  admins_see_all_sessions?: boolean;
  /** Set while the workspace's automations are paused. */
  automations_paused_at?: string | null;
  /**
   * `true` for a legacy account that still holds several projects, until the
   * split gives each one its own account. Its settings, members and billing
   * are shared with those other projects until then.
   */
  split_pending?: boolean;
}

/** One workspace with its settings: what {@link getWorkspace} returns. */
export interface Workspace extends WorkspaceSummary, WorkspaceSettings {}

/** The fields {@link updateWorkspace} changes. Omitted fields stay as they are. */
export type WorkspaceUpdateInput = Partial<Omit<ProjectInput, 'account_id' | 'repo_url'>>;

/** One account's loaded project list, as {@link buildWorkspaceSummaries} reads it. */
export interface WorkspaceProjectList {
  accountId: string;
  /** `undefined` while the list loads or after it failed. */
  data: KortixProject[] | undefined;
}

/** A person in a workspace. */
export type WorkspaceMember = AccountMember;
/** A pending invitation into a workspace. */
export type WorkspaceInvitation = AccountInvitation;
/** What {@link inviteWorkspaceMember} sends. */
export interface InviteWorkspaceMemberInput {
  email: string;
  role?: AccountRole;
  project_grants?: InviteProjectGrant[];
}
/** What {@link createWorkspaceToken} sends. The workspace names the account. */
export type CreateWorkspaceTokenInput = Omit<CreateAccountTokenInput, 'accountId'>;

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The caller's workspace role from the two stored roles: the account role
 * (`owner`/`admin`) wins; a project `manager` is `manager`; everything else
 * is `member`.
 */
export function workspaceRole(input: {
  accountRole?: string | null;
  projectRole?: ProjectRole | string | null;
}): WorkspaceRole {
  if (input.accountRole === 'owner' || input.accountRole === 'admin') return input.accountRole;
  if (input.projectRole === 'manager') return 'manager';
  return 'member';
}

/**
 * A workspace summary from a project row and, when the caller belongs to it,
 * the owning account. A `role` the server already sent wins.
 */
export function workspaceFromProject(
  project: KortixProject,
  account?: Pick<KortixAccount, 'account_role'> | null,
): WorkspaceSummary {
  const served = (project as Partial<WorkspaceSummary>).role;
  return {
    ...project,
    workspace_id: project.project_id,
    role:
      served ??
      workspaceRole({
        accountRole: account?.account_role ?? null,
        projectRole: project.effective_project_role ?? project.project_role ?? null,
      }),
  };
}

/**
 * One summary per active project the caller can open, in input order. A
 * project whose account is not in `accounts` (shared into an account the
 * caller does not belong to) is still listed. The same project listed by two
 * accounts is listed once. Archived projects are not workspaces.
 */
export function buildWorkspaceSummaries(input: {
  accounts: Pick<KortixAccount, 'account_id' | 'account_role'>[];
  lists: WorkspaceProjectList[];
}): WorkspaceSummary[] {
  const accountById = new Map(input.accounts.map((account) => [account.account_id, account]));
  const seen = new Set<string>();
  const summaries: WorkspaceSummary[] = [];
  for (const list of input.lists) {
    for (const project of list.data ?? []) {
      if (project.status === 'archived' || seen.has(project.project_id)) continue;
      seen.add(project.project_id);
      summaries.push(workspaceFromProject(project, accountById.get(project.account_id)));
    }
  }
  return summaries;
}

function openedAt(workspace: Pick<KortixProject, 'last_opened_at'>): number {
  return workspace.last_opened_at ? new Date(workspace.last_opened_at).getTime() : 0;
}

/** Sort order of every workspace list: most recently opened first, then by name. */
export function compareWorkspacesByRecent(
  a: Pick<KortixProject, 'last_opened_at' | 'name'>,
  b: Pick<KortixProject, 'last_opened_at' | 'name'>,
): number {
  return openedAt(b) - openedAt(a) || a.name.localeCompare(b.name);
}

// ── Reads and writes ────────────────────────────────────────────────────────

/**
 * Every workspace the caller can open, most recently opened first.
 *
 * Today this is `GET /accounts` and then `GET /projects?account_id=` per
 * account, in parallel. An account with no project (a dormant account) is
 * not a workspace. One account whose list fails does not hide the others; the
 * call rejects only when the account read fails or every list fails.
 */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const accounts = await listAccounts();
  if (accounts.length === 0) return [];
  const settled = await Promise.allSettled(
    accounts.map((account) => listProjectsForAccount(account.account_id)),
  );
  const firstFailure = settled.find((result) => result.status === 'rejected');
  if (firstFailure && settled.every((result) => result.status === 'rejected')) {
    throw (firstFailure as PromiseRejectedResult).reason;
  }
  const lists = accounts.map((account, index) => {
    const result = settled[index];
    return {
      accountId: account.account_id,
      data: result?.status === 'fulfilled' ? result.value : undefined,
    };
  });
  return buildWorkspaceSummaries({ accounts, lists }).sort(compareWorkspacesByRecent);
}

function settingsFromAccount(detail: AccountDetail): WorkspaceSettings & { role: AccountRole } {
  const settings: WorkspaceSettings & { role: AccountRole } = {
    role: detail.role,
    member_count: detail.member_count,
  };
  if (detail.mfa_required !== undefined) settings.mfa_required = detail.mfa_required;
  if (detail.branding !== undefined) settings.branding = detail.branding;
  return settings;
}

/**
 * One workspace with the caller's role and the workspace settings.
 *
 * Today this is `GET /projects/:id` and then `GET /accounts/:accountId`. A
 * caller who may open the workspace but is not a member of its account still
 * gets the workspace, without the settings. Rejects with the project read's
 * `ApiError` (404: no such workspace, or no access).
 */
export async function getWorkspace(workspaceId: string, options?: ApiClientOptions): Promise<Workspace> {
  const project = await getProject(workspaceId, options);
  const served = project as KortixProject & Partial<Workspace>;
  if (served.role !== undefined) return workspaceFromProject(project) as Workspace;
  let settings: (WorkspaceSettings & { role: AccountRole }) | null = null;
  try {
    settings = settingsFromAccount(await getAccountQuietly(project.account_id));
  } catch (error) {
    // Not a member of the account: the workspace without its settings.
    if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) throw error;
  }
  if (!settings) return workspaceFromProject(project, null);
  const { role: accountRole, ...rest } = settings;
  return { ...workspaceFromProject(project, { account_role: accountRole }), ...rest };
}

/** `GET /accounts/:id` without a toast: a 403 here is an expected answer. */
async function getAccountQuietly(accountId: string): Promise<AccountDetail> {
  const response = await backendApi.get<AccountDetail>(`/accounts/${accountId}`, { showErrors: false });
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Workspace settings request failed');
  }
  return response.data;
}

/**
 * Change the workspace's name, icon or other editable fields. A rename
 * changes the one workspace name everywhere (the API keeps `kortix.yaml` and
 * the account in step). Answers with the updated workspace summary.
 */
export async function updateWorkspace(
  workspaceId: string,
  input: WorkspaceUpdateInput,
): Promise<WorkspaceSummary> {
  return workspaceFromProject(await updateProject(workspaceId, input));
}

/**
 * The internal account id of a workspace: its billing and directory key.
 * Only needed to call an older `Account*` function; every `Workspace*`
 * function takes the workspace id.
 */
export async function resolveWorkspaceAccountId(workspaceId: string): Promise<string> {
  return (await getProject(workspaceId)).account_id;
}

// ── Members and invites ─────────────────────────────────────────────────────

/** Everyone in the workspace, with their role, groups and direct grants. */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return listAccountMembers(await resolveWorkspaceAccountId(workspaceId));
}

/** Invite a person by email. 409 when they are already a member. */
export async function inviteWorkspaceMember(
  workspaceId: string,
  input: InviteWorkspaceMemberInput,
): Promise<InviteMemberResult> {
  return inviteAccountMember(await resolveWorkspaceAccountId(workspaceId), input);
}

export async function updateWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: AccountRole,
): Promise<WorkspaceMember> {
  return updateAccountMemberRole(await resolveWorkspaceAccountId(workspaceId), userId, role);
}

export async function removeWorkspaceMember(workspaceId: string, userId: string) {
  return removeAccountMember(await resolveWorkspaceAccountId(workspaceId), userId);
}

/** The caller leaves the workspace. */
export async function leaveWorkspace(workspaceId: string) {
  return leaveAccount(await resolveWorkspaceAccountId(workspaceId));
}

export async function listWorkspaceInvites(workspaceId: string): Promise<WorkspaceInvitation[]> {
  return listAccountInvites(await resolveWorkspaceAccountId(workspaceId));
}

export async function cancelWorkspaceInvite(workspaceId: string, inviteId: string) {
  return cancelAccountInvite(await resolveWorkspaceAccountId(workspaceId), inviteId);
}

export async function resendWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
): Promise<ResendInviteResult> {
  return resendAccountInvite(await resolveWorkspaceAccountId(workspaceId), inviteId);
}

// ── Personal access tokens ──────────────────────────────────────────────────

/** The workspace's personal access tokens (`kortix_pat_…`). `mine` narrows to the caller's own. */
export async function listWorkspaceTokens(workspaceId: string, options?: ListAccountTokensOptions) {
  return listAccountTokens(await resolveWorkspaceAccountId(workspaceId), options);
}

/** Mint a personal access token for the workspace. `secret_key` is returned once. */
export async function createWorkspaceToken(workspaceId: string, input: CreateWorkspaceTokenInput) {
  return createAccountToken({ ...input, accountId: await resolveWorkspaceAccountId(workspaceId) });
}

export async function revokeWorkspaceToken(
  workspaceId: string,
  tokenId: string,
  options?: { deleteRevoked?: boolean },
) {
  return revokeAccountToken(tokenId, await resolveWorkspaceAccountId(workspaceId), options);
}

// ── Billing ─────────────────────────────────────────────────────────────────

/** The workspace's plan, credits and limits (`AccountState`). */
export async function getWorkspaceBillingState(
  workspaceId: string,
  options?: Omit<GetAccountStateOptions, 'accountId'>,
) {
  return getAccountState({ ...options, accountId: await resolveWorkspaceAccountId(workspaceId) });
}

// ── Identity and access ─────────────────────────────────────────────────────

/** The workspace's role assignments, optionally narrowed. */
export async function listWorkspaceAssignments(workspaceId: string, filter?: ListAssignmentsFilter) {
  return listAssignments(await resolveWorkspaceAccountId(workspaceId), filter);
}

export async function createWorkspaceAssignment(workspaceId: string, input: AssignmentInput) {
  return createAssignment(await resolveWorkspaceAccountId(workspaceId), input);
}

export async function revokeWorkspaceAssignment(workspaceId: string, assignmentId: string) {
  return revokeAssignment(await resolveWorkspaceAccountId(workspaceId), assignmentId);
}

/** The workspace's built-in and custom roles. */
export async function listWorkspaceRoles(workspaceId: string) {
  return listRoles(await resolveWorkspaceAccountId(workspaceId));
}

/** The workspace's groups. */
export async function listWorkspaceGroups(workspaceId: string) {
  return listGroups(await resolveWorkspaceAccountId(workspaceId));
}

/** Ask the engine whether `userId` may do one thing in the workspace. */
export async function probeWorkspacePermission(
  workspaceId: string,
  userId: string,
  args: PermissionProbeInput,
) {
  return probeEffectivePermission(await resolveWorkspaceAccountId(workspaceId), userId, args);
}

/** Batch form of {@link probeWorkspacePermission}: one request for N actions. */
export async function probeWorkspacePermissions(
  workspaceId: string,
  userId: string,
  probes: PermissionProbeInput[],
  options?: { showErrors?: boolean },
) {
  return probeEffectivePermissions(await resolveWorkspaceAccountId(workspaceId), userId, probes, options);
}
