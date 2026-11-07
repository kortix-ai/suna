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
// Routes: every function here calls the canonical `/v1/workspaces[/:workspaceId/*]`
// name with the WORKSPACE id; none resolves the account first. A canonical
// path takes the workspace id only: an account id answers 404
// `workspace_not_found`. The API serves the older `/v1/projects/*` and
// `/v1/accounts/*` names permanently (either id), and the older `Project*` /
// `Account*` functions keep calling them.

import { ApiError, type ApiClientOptions, backendApi } from '../../http/api-client';
import {
  type AccountBranding,
  type AccountDetail,
  type AccountInvitation,
  type AccountMember,
  type InviteMemberResult,
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
import {
  type KortixProject,
  type ProjectInput,
  type ProvisionProjectInput,
  type ProvisionStreamEvent,
  listWorkspacesForAccount,
  provisionWorkspace,
  provisionWorkspaceStream,
} from './projects';
import { readProvisionStream } from './provision-stream';
import { type AccountRole, type ProjectRole, unwrap } from './shared';
import type { AccountToken, CreateAccountTokenInput, CreatedAccountToken, ListAccountTokensOptions, WorkspaceKeyScopes } from './tokens';

/**
 * The caller's role in a workspace. `owner` and `admin` administer it
 * (members, billing, SSO, keys). `manager` manages its agents, skills and
 * sessions. `member` reads and runs.
 */
export type WorkspaceRole = 'owner' | 'admin' | 'manager' | 'member';

/**
 * The served state of a workspace. `active`: in use. `setup_required`: it pays
 * (a plan or bought credits) but has no repository yet: {@link setupWorkspace}.
 * `deleting`: deleted and inside its restore window ({@link restoreWorkspace});
 * only its owners see it.
 */
export type WorkspaceState = 'active' | 'setup_required' | 'deleting';

/**
 * One workspace in a list: the workspace's row plus its id, the caller's
 * role and the workspace state. It carries every `KortixProject` field, so it
 * works wherever a `KortixProject` is expected.
 */
export interface WorkspaceSummary extends KortixProject {
  /** The workspace id: the same value as `project_id`. Use it in every URL and call. */
  workspace_id: string;
  /** The caller's role in this workspace. */
  role: WorkspaceRole;
  /** `active` on an older API, which lists active workspaces only. */
  state: WorkspaceState;
  /** True while a legacy account still holds other workspaces. Absent on older APIs. */
  split_pending?: boolean;
  /** When a `deleting` workspace is erased; null otherwise. Absent on older APIs. */
  deletion_scheduled_for?: string | null;
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

/** How a secret with no strategy of its own reaches a session. */
export type WorkspaceSecretStrategy = 'runtime' | 'egress' | 'broker' | 'denied';

/**
 * Set for 30 days after a legacy account with several projects became one
 * workspace per project. `keeper`: this workspace kept the legacy account
 * (its plan, credits and billing history). `moved`: it was split off.
 */
export interface WorkspaceSplitNotice {
  role: 'keeper' | 'moved';
  /** The legacy account's name before the split. */
  source_name: string;
  /** When the legacy account's last project moved (ISO-8601). */
  completed_at: string;
  /**
   * A split-off's plan: `free` (with this month's free credits) or `comped`
   * (the keeper's plan at no charge until `comped_until`, then Free). Null for
   * the keeper, and while the split-off's billing has not applied yet.
   */
  billing: 'free' | 'comped' | null;
  comped_until: string | null;
}

/** One workspace with its settings: what {@link getWorkspace} returns. */
export interface Workspace extends WorkspaceSummary, WorkspaceSettings {
  /** How a secret with no strategy of its own reaches a session. Absent on older APIs. */
  secret_default_strategy?: WorkspaceSecretStrategy;
  /** The split notice, or null. Absent on older APIs. */
  split_notice?: WorkspaceSplitNotice | null;
}

/**
 * The fields {@link updateWorkspace} changes. Omitted fields stay as they are.
 * A workspace setting (MFA, session and key policy, branding, automations) is
 * not one of them: the API answers 400 `workspace_setting_read_only` and
 * names the route that writes it.
 */
export type WorkspaceUpdateInput = Partial<Omit<ProjectInput, 'account_id' | 'repo_url'>> & {
  secret_default_strategy?: WorkspaceSecretStrategy;
};

/**
 * One account's loaded list, as {@link buildWorkspaceSummaries} reads it (the
 * one-list-per-account read of an older API).
 */
export interface WorkspaceSourceList {
  accountId: string;
  /** `undefined` while the list loads or after it failed. */
  data: KortixProject[] | undefined;
}

/** A person in a workspace. */
export type WorkspaceMember = AccountMember;
/** A pending invitation into a workspace. */
export type WorkspaceInvitation = AccountInvitation;
/** What {@link inviteWorkspaceMember} sends. An owner is made by transfer, never by invite. */
export interface InviteWorkspaceMemberInput {
  email: string;
  /** Default `member`. */
  role?: Exclude<WorkspaceRole, 'owner'>;
  /** ISO-8601: the membership ends then. */
  expires_at?: string;
}
/** What {@link createWorkspaceToken} sends. The key acts on the workspace in the path only. */
export type CreateWorkspaceTokenInput = Omit<CreateAccountTokenInput, 'accountId' | 'projectId' | 'renews'> & {
  /** What the key may do inside your role: `full` (default), `read`, or a list of permissions. */
  scopes?: WorkspaceKeyScopes;
};

/** A personal key of the caller (`GET /v1/me/tokens`): acts as the person in each workspace. */
export interface PersonalToken extends AccountToken {
  /** `null`: a personal key is bound to no workspace. */
  workspace_id?: string | null;
}

/** What {@link deleteWorkspace} answers. */
export interface DeleteWorkspaceResult {
  ok: boolean;
  deleted: boolean;
  archived: boolean;
  repo_deleted: boolean;
  /** When the workspace is erased; until then its owners can restore it. Null for a legacy split workspace. */
  deletion_scheduled_for: string | null;
}

/** One workspace that blocks deleting the person: they are its sole owner and others are in it. */
export interface PersonDeletionBlocker {
  workspace_id: string;
  name: string;
  member_count: number;
}

/** What deleting the caller's account would do (`GET /v1/account/deletion-plan`). */
export interface PersonDeletionPlan {
  /** Workspaces deleted with the person: they are the sole owner and only member. */
  delete_workspaces: string[];
  /** Workspaces the person leaves. */
  leave_workspaces: string[];
  /** Transfer ownership or remove the members of these first. */
  blockers: PersonDeletionBlocker[];
  /** The name of every workspace listed above, keyed by workspace id. An older API omits it. */
  workspace_names?: Record<string, string>;
}

/** What {@link setupWorkspace} sends: the repository fields of a new workspace. */
export type SetupWorkspaceInput = Omit<ProvisionProjectInput, 'account_id' | 'name'>;

// ── Error codes ─────────────────────────────────────────────────────────────

/** 409: the account already holds its workspace's project. The body names it (`workspace_id`). */
export const WORKSPACE_HAS_PROJECT_CODE = 'workspace_has_project' as const;
/** 404: no such workspace, an account id on a canonical path, or no access. */
export const WORKSPACE_NOT_FOUND_CODE = 'workspace_not_found' as const;
/** 409: the workspace has no repository yet: {@link setupWorkspace}. */
export const WORKSPACE_SETUP_REQUIRED_CODE = 'workspace_setup_required' as const;
/** 409: the workspace is being deleted; an owner restores it first ({@link restoreWorkspace}). */
export const WORKSPACE_DELETING_CODE = 'workspace_deleting' as const;
/** 400: `updateWorkspace` named a setting; the body's `writer` names the route that writes it. */
export const WORKSPACE_SETTING_READ_ONLY_CODE = 'workspace_setting_read_only' as const;

/** True when `error` is the API's 409 `workspace_has_project`. Duck-typed on `code`. */
export function isWorkspaceHasProjectError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === WORKSPACE_HAS_PROJECT_CODE;
}

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
    state: (project as Partial<WorkspaceSummary>).state ?? 'active',
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
  lists: WorkspaceSourceList[];
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

/** What {@link listWorkspaces} takes. */
export interface ListWorkspacesOptions {
  /** Also list `setup_required` and (for owners) `deleting` workspaces. Default: active only. */
  includeInactive?: boolean;
}

function isServedSummary(row: unknown): row is WorkspaceSummary {
  const r = row as Partial<WorkspaceSummary> | null;
  return !!r && typeof r.project_id === 'string' && typeof r.role === 'string' && typeof r.state === 'string';
}

/**
 * Every workspace the caller can open, across every account, in ONE request
 * (`GET /v1/workspaces`), most recently opened first. A workspace-bound key
 * lists its one workspace. `setup_required` and `deleting` workspaces are
 * left out unless `includeInactive`.
 *
 * An older API (list items without `state`, or a 404) is read the older way:
 * `GET /accounts`, then `GET /projects?account_id=` per account, in parallel.
 * There one account whose list fails does not hide the others; the call
 * rejects only when the account read fails or every list fails.
 */
export async function listWorkspaces(options: ListWorkspacesOptions = {}): Promise<WorkspaceSummary[]> {
  const served = await backendApi.get<unknown[]>('/workspaces', { showErrors: false });
  if (served.success && Array.isArray(served.data) && served.data.length > 0 && served.data.every(isServedSummary)) {
    const rows = served.data as WorkspaceSummary[];
    return options.includeInactive ? rows : rows.filter((row) => row.state === 'active');
  }
  if (!served.success && served.error?.status !== 404) {
    throw served.error ?? new Error('Workspace list request failed');
  }
  return listWorkspacesPerAccount();
}

/** The older API's read: the accounts, then each account's projects. */
async function listWorkspacesPerAccount(): Promise<WorkspaceSummary[]> {
  const accounts = await listAccounts();
  if (accounts.length === 0) return [];
  const settled = await Promise.allSettled(
    accounts.map((account) => listWorkspacesForAccount(account.account_id)),
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
  return workspaceFromServed(unwrap(await backendApi.get<ServedWorkspace>(`/workspaces/${workspaceId}`, options)));
}

/**
 * A served Workspace record, flattened: the `workspace` settings block's
 * fields move to the top level (its duplicated ids and its `account_role`
 * are dropped), and the served `role` and `state` win over derived ones.
 * Reads the account the older way when an older API sent no block and no role.
 */
async function workspaceFromServed(served: ServedWorkspace): Promise<Workspace> {
  const { workspace: block, ...project } = served;
  if (block) {
    const { account_role: accountRole, workspace_id: _id, account_id: _account, ...settings } = block;
    return { ...workspaceFromProject(project, accountRole ? { account_role: accountRole } : null), ...settings };
  }
  if (project.role !== undefined) return workspaceFromProject(project) as Workspace;
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
 * Change the workspace's name, icon, branch, manifest path or secret default.
 * A rename changes the one workspace name everywhere (the API keeps
 * `kortix.yaml` and the account in step). Answers with the updated workspace.
 */
export async function updateWorkspace(workspaceId: string, input: WorkspaceUpdateInput): Promise<Workspace> {
  return workspaceFromServed(unwrap(await backendApi.patch<ServedWorkspace>(`/workspaces/${workspaceId}`, input)));
}

// ── Create, delete, restore, set up ─────────────────────────────────────────

/**
 * What {@link createWorkspace} takes: the name and the repository fields of a
 * new workspace. A new workspace names no account: it always gets its own.
 */
export type CreateWorkspaceInput = Omit<ProvisionProjectInput, 'account_id'>;

/** True when `POST /v1/workspaces` is not the workspace create on this API (an older server). */
function isOlderCreateRoute(error: { status?: number; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.status === 404 || error.status === 405) return true;
  // Before the workspace resource, POST /v1/workspaces was the GitHub import of POST /v1/projects.
  return error.status === 400 && error.message === 'repo_url is required';
}

function createdFromProject(project: KortixProject): Workspace {
  return { ...workspaceFromProject(project, { account_role: 'owner' }), state: 'active' } as Workspace;
}

/**
 * Create a whole workspace in one call: `POST /v1/workspaces`. It always gets
 * a new account; only a replay of the same `idempotency_key` answers the
 * workspace that key already created. Answers the {@link Workspace} (the
 * caller is its owner).
 *
 * - `onEvent` given: streams the same request (`Accept: text/event-stream`)
 *   and reports the {@link ProvisionStreamEvent}s (`validating` →
 *   `creating_repository` → `registering` → `seeding`). Needs a streaming
 *   `fetch`; on React Native omit `onEvent`.
 * - `onEvent` omitted: one request and response.
 *
 * On an older API the call sends `new_workspace: true` to
 * `POST /v1/projects/provision` (or `/provision-stream`) instead.
 *
 * Rejects with an `ApiError`. Codes a host handles: `account_creation_restricted`
 * (403: this deployment lets only its admin create workspaces; ask for an
 * invite), `new_workspace_requires_person` (403: an API key, a service
 * account or a workspace key), `impersonation_invalid` (403),
 * `provision_in_flight` (409: retry with the same key).
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  onEvent?: (event: ProvisionStreamEvent) => void,
  options: ApiClientOptions = {},
): Promise<Workspace> {
  const { account_id: _account, new_workspace: _flag, ...fields } = input as CreateWorkspaceInput & {
    account_id?: unknown;
    new_workspace?: unknown;
  };
  const body = { seed_starter: true, ...fields };
  const legacyBody = { ...fields, new_workspace: true } as ProvisionProjectInput & { new_workspace: true };

  if (onEvent) {
    const response = await backendApi.postStream('/workspaces', body, options);
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string; message?: string; code?: string } | null;
      const message = error?.error && typeof error.error === 'string' ? error.error : error?.message;
      if (isOlderCreateRoute({ status: response.status, message })) {
        return createdFromProject(await provisionWorkspaceStream(legacyBody, onEvent, options));
      }
      throw new ApiError(message || `Create workspace failed: HTTP ${response.status}`, {
        status: response.status,
        code: error?.code,
      });
    }
    const done = await readProvisionStream(response, onEvent);
    return done.workspace ? workspaceFromServed(done.workspace as ServedWorkspace) : createdFromProject(done.project);
  }

  const created = await backendApi.post<ServedWorkspace>('/workspaces', body, { ...options, showErrors: false });
  if (created.success && created.data) return workspaceFromServed(created.data);
  if (isOlderCreateRoute(created.error)) return createdFromProject(await provisionWorkspace(legacyBody, options));
  throw created.error ?? new Error('Create workspace failed');
}

/**
 * Delete a workspace: `DELETE /v1/workspaces/:id`. Its members lose access at
 * once, its plan is cancelled at the end of the period, and it is erased at
 * `deletion_scheduled_for`. Until then its owners see it as `deleting` and can
 * {@link restoreWorkspace} it.
 */
export async function deleteWorkspace(workspaceId: string): Promise<DeleteWorkspaceResult> {
  return unwrap(await backendApi.delete<DeleteWorkspaceResult>(`/workspaces/${workspaceId}`));
}

/** Restore a `deleting` workspace (owners): `POST /v1/workspaces/:id/restore`. */
export async function restoreWorkspace(workspaceId: string): Promise<Workspace> {
  return workspaceFromServed(unwrap(await backendApi.post<ServedWorkspace>(`/workspaces/${workspaceId}/restore`, {})));
}

/**
 * Set up a `setup_required` workspace (one that pays but has no repository
 * yet): `POST /v1/workspaces/:id/setup` creates its repository. The workspace
 * id does not change.
 */
export async function setupWorkspace(workspaceId: string, input: SetupWorkspaceInput = {}): Promise<Workspace> {
  return workspaceFromServed(unwrap(await backendApi.post<ServedWorkspace>(`/workspaces/${workspaceId}/setup`, input)));
}

// ── The person: personal keys and account deletion ──────────────────────────

/** The caller's personal keys (the CLI login and older account-wide keys): `GET /v1/me/tokens`. */
export async function listPersonalTokens(): Promise<PersonalToken[]> {
  return unwrap(await backendApi.get<PersonalToken[]>('/me/tokens'));
}

/** Revoke one of the caller's personal keys: `DELETE /v1/me/tokens/:tokenId`. */
export async function revokePersonalToken(tokenId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(`/me/tokens/${encodeURIComponent(tokenId)}`));
}

/**
 * What deleting the caller's account would do: the workspaces deleted with
 * them, the ones they leave, and the shared ones they must hand over first.
 */
export async function getPersonDeletionPlan(): Promise<PersonDeletionPlan> {
  return unwrap(await backendApi.get<PersonDeletionPlan>('/account/deletion-plan'));
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

/** Change a person's role. Only an owner makes an owner. */
export async function updateWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
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

/**
 * Mint a workspace key: it acts on this workspace only (`workspace_id` in the
 * response). `secret_key` is returned once. A person's own key that acts in
 * every workspace of theirs is a personal key ({@link listPersonalTokens}).
 */
export async function createWorkspaceToken(workspaceId: string, input: CreateWorkspaceTokenInput) {
  const { expiresAt, name, scopes } = input;
  return unwrap(
    await backendApi.post<CreatedAccountToken>(`/workspaces/${workspaceId}/tokens`, {
      name,
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(scopes !== undefined ? { scopes } : {}),
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

// ── API keys (one concept: who the key acts as) ─────────────────────────────

/** Who a workspace key authorizes as. */
export type WorkspaceKeyPrincipal = 'me' | 'agent' | 'bot';

/** The principal of a {@link WorkspaceKey}. */
export interface WorkspaceKeyActsAs {
  type: WorkspaceKeyPrincipal;
  /** The agent or bot name; null for `me`. */
  name: string | null;
  /** The service account the key authorizes as; null for `me`. */
  service_account_id: string | null;
}

/** One row of Workspace settings › API keys (`GET /v1/workspaces/:id/keys`). */
export interface WorkspaceKey {
  key_id: string;
  name: string;
  acts_as: WorkspaceKeyActsAs;
  /** `service_account_bearer`: a bot's own `kortix_sa_` bearer from before workspace keys. */
  credential: 'token' | 'service_account_bearer';
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  created_by: string | null;
  created_by_email: string | null;
  scope: 'full' | 'read' | 'custom';
  permissions: string[] | null;
  workspace_permissions: string[] | null;
  expiry_renews: boolean;
}

/** A just-created {@link WorkspaceKey}: `secret_key` is returned once. */
export interface CreatedWorkspaceKey extends WorkspaceKey {
  secret_key: string;
}

/** What {@link listWorkspaceKeys} answers: the keys, and what a new key may act as. */
export interface WorkspaceKeyList {
  keys: WorkspaceKey[];
  /** The caller may create and revoke agent and bot keys (`token.create`). */
  can_manage_principals: boolean;
  /** The agents a key can act as (enabled kortix.yaml agents, never My Kortix). */
  agents: Array<{ name: string }>;
  /** The workspace's bots. `has_role: false`: its key can do nothing until the bot has a role. */
  bots: Array<{ bot_id: string; name: string; has_role: boolean }>;
}

/** Who a new key acts as. `bot` is a bot name or id; a new name creates the bot. */
export type WorkspaceKeyActsAsInput =
  | { type: 'me' }
  | { type: 'agent'; agent: string }
  | { type: 'bot'; bot: string };

/** What {@link createWorkspaceKey} sends. */
export interface CreateWorkspaceKeyInput {
  name: string;
  /** Default `{ type: 'me' }`. */
  actsAs?: WorkspaceKeyActsAsInput;
  /** `full` (default), `read`, or permissions inside the principal's own rights. */
  scopes?: WorkspaceKeyScopes;
  /** ISO-8601; omitted = 90 days; `null` = no expiry where the key policy allows it. */
  expiresAt?: string | null;
}

/** Every key of the workspace the caller may see, and the agents and bots a new key can act as. */
export async function listWorkspaceKeys(workspaceId: string) {
  return unwrap(await backendApi.get<WorkspaceKeyList>(`/workspaces/${workspaceId}/keys`));
}

/** Create a key that acts as you, an agent or a bot. `secret_key` is returned once. */
export async function createWorkspaceKey(workspaceId: string, input: CreateWorkspaceKeyInput) {
  const actsAs = input.actsAs ?? { type: 'me' };
  return unwrap(
    await backendApi.post<CreatedWorkspaceKey>(`/workspaces/${workspaceId}/keys`, {
      name: input.name,
      acts_as: actsAs.type,
      ...(actsAs.type === 'agent' ? { agent: actsAs.agent } : {}),
      ...(actsAs.type === 'bot' ? { bot: actsAs.bot } : {}),
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    }),
  );
}

/** Revoke a key of the workspace; `deleteRevoked` removes a revoked key of yours or a disabled bot bearer. */
export async function revokeWorkspaceKey(
  workspaceId: string,
  keyId: string,
  options?: { deleteRevoked?: boolean },
) {
  const qs = options?.deleteRevoked ? '?delete_revoked=true' : '';
  return unwrap(
    await backendApi.delete<{ ok: boolean; deleted?: boolean }>(
      `/workspaces/${workspaceId}/keys/${encodeURIComponent(keyId)}${qs}`,
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
