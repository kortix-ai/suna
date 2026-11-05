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
// Routes: every function here calls the canonical `/v1/workspaces/:workspaceId/*`
// name with the workspace id; none resolves the account first. The API serves
// the older `/v1/projects/*` and `/v1/accounts/*` names permanently, and the
// older `Project*` / `Account*` functions keep calling them.

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
  listAccounts,
} from './accounts';
import type { AssignmentInput, ListAssignmentsFilter, RoleAssignment } from './assignments';
import { assignmentBody, assignmentQuery } from './assignments-at';
import { type GetAccountStateOptions, getAccountState } from './billing';
import { iamGet, iamUnwrap } from './iam-shared';
import type { PermissionProbeInput, PermissionProbeResult } from './iam-probe';
import type { AccountGroup, IamRole } from './iam-types';
import { type KortixProject, type ProjectInput, listProjectsForAccount } from './projects';
import { type AccountRole, type ProjectRole, unwrap } from './shared';
import type { AccountToken, CreateAccountTokenInput, CreatedAccountToken, ListAccountTokensOptions } from './tokens';

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

/** The `workspace` block `GET /v1/workspaces/:id` adds to the project record. */
interface ServedWorkspaceBlock extends WorkspaceSettings {
  workspace_id?: string;
  account_id?: string;
  /** The caller's account role; null when the caller holds project grants only. */
  account_role?: string | null;
}

type ServedWorkspace = KortixProject & Partial<Workspace> & { workspace?: ServedWorkspaceBlock | null };

/**
 * One workspace with the caller's role and the workspace settings: one
 * `GET /v1/workspaces/:id`. A caller who may open the workspace but is not a
 * member of its account gets the workspace with role `manager` or `member`.
 * Rejects with the API's `ApiError` (404: no such workspace, or no access).
 */
export async function getWorkspace(workspaceId: string, options?: ApiClientOptions): Promise<Workspace> {
  const served = unwrap(await backendApi.get<ServedWorkspace>(`/workspaces/${workspaceId}`, options));
  const { workspace: block, ...project } = served;
  if (project.role !== undefined) return workspaceFromProject(project) as Workspace;
  if (block) {
    const { account_role: accountRole, workspace_id: _id, account_id: _account, ...settings } = block;
    return { ...workspaceFromProject(project, accountRole ? { account_role: accountRole } : null), ...settings };
  }
  // No settings block (the workspace row is not readable as a workspace):
  // read the account the older way, quietly.
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
  return workspaceFromProject(unwrap(await backendApi.patch<KortixProject>(`/workspaces/${workspaceId}`, input)));
}

/**
 * The internal account id of a workspace: its billing and directory key.
 * Only needed to call an older `Account*` function; every `Workspace*`
 * function takes the workspace id.
 */
export async function resolveWorkspaceAccountId(workspaceId: string): Promise<string> {
  return unwrap(await backendApi.get<KortixProject>(`/workspaces/${workspaceId}`)).account_id;
}

// ── Members and invites ─────────────────────────────────────────────────────

/** Everyone in the workspace, with their role, groups and direct grants. */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return unwrap(await backendApi.get<AccountMember[]>(`/workspaces/${workspaceId}/members`));
}

/** Invite a person by email. 409 when they are already a member. */
export async function inviteWorkspaceMember(
  workspaceId: string,
  input: InviteWorkspaceMemberInput,
): Promise<InviteMemberResult> {
  return unwrap(
    await backendApi.post<InviteMemberResult>(`/workspaces/${workspaceId}/members`, input, {
      // 409 (already a member) is an expected business error; the page shows it inline.
      showErrors: false,
    }),
  );
}

export async function updateWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: AccountRole,
): Promise<WorkspaceMember> {
  return unwrap(
    await backendApi.patch<AccountMember>(`/workspaces/${workspaceId}/members/${userId}`, { role }),
  );
}

export async function removeWorkspaceMember(workspaceId: string, userId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/workspaces/${workspaceId}/members/${userId}`));
}

/** The caller leaves the workspace. */
export async function leaveWorkspace(workspaceId: string) {
  return unwrap(await backendApi.post<{ ok: boolean }>(`/workspaces/${workspaceId}/leave`, {}));
}

export async function listWorkspaceInvites(workspaceId: string): Promise<WorkspaceInvitation[]> {
  return unwrap(await backendApi.get<AccountInvitation[]>(`/workspaces/${workspaceId}/invites`));
}

export async function cancelWorkspaceInvite(workspaceId: string, inviteId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/workspaces/${workspaceId}/invites/${inviteId}`));
}

export async function resendWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
): Promise<ResendInviteResult> {
  return unwrap(
    await backendApi.post<ResendInviteResult>(`/workspaces/${workspaceId}/invites/${inviteId}/resend`, {}),
  );
}

// ── Personal access tokens ──────────────────────────────────────────────────

/** The workspace's personal access tokens (`kortix_pat_…`). `mine` narrows to the caller's own. */
export async function listWorkspaceTokens(workspaceId: string, options?: ListAccountTokensOptions) {
  const qs = options?.mine ? '?mine=true' : '';
  return unwrap(await backendApi.get<AccountToken[]>(`/workspaces/${workspaceId}/tokens${qs}`));
}

/** Mint a personal access token for the workspace. `secret_key` is returned once. */
export async function createWorkspaceToken(workspaceId: string, input: CreateWorkspaceTokenInput) {
  const { expiresAt, projectId, name } = input;
  return unwrap(
    await backendApi.post<CreatedAccountToken>(`/workspaces/${workspaceId}/tokens`, {
      name,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    }),
  );
}

export async function revokeWorkspaceToken(
  workspaceId: string,
  tokenId: string,
  options?: { deleteRevoked?: boolean },
) {
  const qs = options?.deleteRevoked ? '?delete_revoked=true' : '';
  return unwrap(
    await backendApi.delete<{ ok: boolean; deleted?: boolean }>(
      `/workspaces/${workspaceId}/tokens/${encodeURIComponent(tokenId)}${qs}`,
    ),
  );
}

// ── Billing ─────────────────────────────────────────────────────────────────

/**
 * The workspace's plan, credits and limits (`AccountState`). The billing
 * routes take `?account_id=` and accept a workspace id there.
 */
export async function getWorkspaceBillingState(
  workspaceId: string,
  options?: Omit<GetAccountStateOptions, 'accountId'>,
) {
  return getAccountState({ ...options, accountId: workspaceId });
}

// ── Identity and access ─────────────────────────────────────────────────────

/** The workspace's role assignments, optionally narrowed. */
export async function listWorkspaceAssignments(workspaceId: string, filter?: ListAssignmentsFilter) {
  return iamUnwrap(
    await iamGet<{ assignments: RoleAssignment[] }>(
      `/workspaces/${workspaceId}/iam/assignments${assignmentQuery(filter)}`,
    ),
  ).assignments;
}

export async function createWorkspaceAssignment(workspaceId: string, input: AssignmentInput) {
  return unwrap(
    await backendApi.post<RoleAssignment>(`/workspaces/${workspaceId}/iam/assignments`, assignmentBody(input)),
  );
}

export async function revokeWorkspaceAssignment(workspaceId: string, assignmentId: string) {
  return unwrap(
    await backendApi.delete<{ revoked: boolean; assignment: RoleAssignment }>(
      `/workspaces/${workspaceId}/iam/assignments/${assignmentId}`,
    ),
  ).assignment;
}

/** The workspace's built-in and custom roles. */
export async function listWorkspaceRoles(workspaceId: string) {
  return iamUnwrap(await iamGet<{ roles: IamRole[] }>(`/workspaces/${workspaceId}/iam/roles`)).roles;
}

/** The workspace's groups. */
export async function listWorkspaceGroups(workspaceId: string) {
  return iamUnwrap(await iamGet<{ groups: AccountGroup[] }>(`/workspaces/${workspaceId}/iam/groups`)).groups;
}

/** Ask the engine whether `userId` may do one thing in the workspace. */
export async function probeWorkspacePermission(
  workspaceId: string,
  userId: string,
  args: PermissionProbeInput,
): Promise<PermissionProbeResult> {
  const [result] = await probeWorkspacePermissions(workspaceId, userId, [args]);
  if (!result) throw new Error('Unexpected empty response');
  return result;
}

/** Batch form of {@link probeWorkspacePermission}: one request for N actions. */
export async function probeWorkspacePermissions(
  workspaceId: string,
  userId: string,
  probes: PermissionProbeInput[],
  options?: { showErrors?: boolean },
) {
  if (probes.length === 0) return [] as PermissionProbeResult[];
  return iamUnwrap(
    await backendApi.post<{ results: PermissionProbeResult[] }>(
      `/workspaces/${workspaceId}/iam/members/${userId}/effective:batch`,
      { probes },
      { showErrors: options?.showErrors ?? true },
    ),
  ).results;
}
