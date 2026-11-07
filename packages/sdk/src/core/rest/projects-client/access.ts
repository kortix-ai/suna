// Project access — members, access requests, project invites, and group grants.

import { backendApi, type ApiClientOptions } from '../../http/api-client';
import { unwrap, type AccountRole, type ProjectRole } from './shared';

/** @deprecated Use `WorkspaceGroupAccessSource`. Kept permanently. */
export interface ProjectGroupAccessSource {
  group_id: string;
  group_name: string;
  role: ProjectRole;
}

/** The workspace name of {@link ProjectGroupAccessSource}: the same type. */
export type WorkspaceGroupAccessSource = ProjectGroupAccessSource;

type ProjectAccessPolicy = {
  policy_id: string;
  role_id: string;
  role_key: string;
  role_name: string;
  scope_type: 'project' | 'account';
  expires_at: string | null;
};

type ProjectAccessResource = {
  grant_id: string;
  resource_type: 'agent' | 'skill';
  resource_id: string;
  expires_at: string | null;
};

type ProjectAccessSource = {
  source: 'direct' | 'group';
  group_id: string | null;
  group_name: string | null;
};

/** @deprecated Use `WorkspaceAccessMember`. Kept permanently. */
export interface ProjectAccessMember {
  custom_role_policies?: (ProjectAccessPolicy & ProjectAccessSource)[];
  resource_grants?: (ProjectAccessResource & Omit<ProjectAccessSource, 'source'> & {
    source: 'direct' | 'group' | 'project';
  })[];
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
  has_implicit_access: boolean;
  /** Which path produced effective_project_role. 'implicit' = account
   *  owner/admin; 'direct' = explicit project_members row; 'group' =
   *  inherited via a project_group_grants attachment. null = no access. */
  effective_source?: 'implicit' | 'direct' | 'group' | null;
  /** Every group attachment that includes this user, sorted by role
   *  desc. Used to label "via X group" on the row. */
  group_sources?: ProjectGroupAccessSource[];
  joined_at: string;
  granted_by: string | null;
  granted_at: string | null;
  updated_at: string | null;
  /** Auto-revoke timestamp for the DIRECT grant (ISO). null = permanent
   *  or no direct grant. */
  expires_at?: string | null;
}

/** The workspace name of {@link ProjectAccessMember}: the same type. */
export type WorkspaceAccessMember = ProjectAccessMember;

/** @deprecated Use `WorkspaceAccessResponse`. Kept permanently. */
export interface ProjectAccessResponse {
  project_id: string;
  account_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: ProjectAccessMember[];
  group_access?: {
    group_id: string;
    group_name: string | null;
    built_in_role: string | null;
    custom_role_policies: ProjectAccessPolicy[];
    resource_grants: ProjectAccessResource[];
  }[];
}

/** The workspace name of {@link ProjectAccessResponse}: the same type. */
export type WorkspaceAccessResponse = ProjectAccessResponse;

/** @deprecated Use `WorkspaceAccessRequest`. Kept permanently. */
export interface ProjectAccessRequest {
  request_id: string;
  account_id: string;
  project_id: string;
  requester_user_id: string;
  requester_email: string;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The workspace name of {@link ProjectAccessRequest}: the same type. */
export type WorkspaceAccessRequest = ProjectAccessRequest;

/** @deprecated Use `RequestWorkspaceAccessResult`. Kept permanently. */
export type RequestProjectAccessResult =
  | { status: 'created'; request: ProjectAccessRequest }
  | { status: 'pending'; request: ProjectAccessRequest }
  | { status: 'already_has_access'; project_id: string };

/** The workspace name of {@link RequestProjectAccessResult}: the same type. */
export type RequestWorkspaceAccessResult = RequestProjectAccessResult;

export async function requestWorkspaceAccess(projectId: string, message?: string) {
  return unwrap(
    await backendApi.post<RequestProjectAccessResult>(
      `/workspaces/${projectId}/access-requests`,
      { message: message?.trim() || undefined },
      { showErrors: false },
    ),
  );
}

/** @deprecated Use `requestWorkspaceAccess`. Kept permanently. */
export const requestProjectAccess = requestWorkspaceAccess;

export async function listWorkspaceAccessRequests(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<{ requests: ProjectAccessRequest[] }>(
      `/workspaces/${projectId}/access-requests`,
      options,
    ),
  );
}

/** @deprecated Use `listWorkspaceAccessRequests`. Kept permanently. */
export const listProjectAccessRequests = listWorkspaceAccessRequests;

export async function approveWorkspaceAccessRequest(
  projectId: string,
  requestId: string,
  role: ProjectRole = 'member',
) {
  return unwrap(
    await backendApi.post<{
      request: ProjectAccessRequest;
      member: ProjectAccessMember;
    }>(`/workspaces/${projectId}/access-requests/${requestId}/approve`, { role }),
  );
}

/** @deprecated Use `approveWorkspaceAccessRequest`. Kept permanently. */
export const approveProjectAccessRequest = approveWorkspaceAccessRequest;

export async function rejectWorkspaceAccessRequest(projectId: string, requestId: string) {
  return unwrap(
    await backendApi.post<{ request: ProjectAccessRequest }>(
      `/workspaces/${projectId}/access-requests/${requestId}/reject`,
      {},
    ),
  );
}

/** @deprecated Use `rejectWorkspaceAccessRequest`. Kept permanently. */
export const rejectProjectAccessRequest = rejectWorkspaceAccessRequest;

export async function listWorkspaceAccess(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectAccessResponse>(
      `/workspaces/${projectId}/access`,
    ),
  );
}

/** @deprecated Use `listWorkspaceAccess`. Kept permanently. */
export const listProjectAccess = listWorkspaceAccess;

export async function updateWorkspaceAccess(
  projectId: string,
  userId: string,
  role: ProjectRole,
) {
  return unwrap(
    await backendApi.put<ProjectAccessMember>(
      `/workspaces/${projectId}/access/${userId}`,
      { role },
    ),
  );
}

/** @deprecated Use `updateWorkspaceAccess`. Kept permanently. */
export const updateProjectAccess = updateWorkspaceAccess;

export async function revokeWorkspaceAccess(projectId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${projectId}/access/${userId}`,
    ),
  );
}

/** @deprecated Use `revokeWorkspaceAccess`. Kept permanently. */
export const revokeProjectAccess = revokeWorkspaceAccess;

/** Two-shape response:
 *  - User had a Kortix account already → ProjectAccessMember row was
 *    inserted/updated; UI refreshes the access list and shows them.
 *  - User had no Kortix account → an account invitation was created
 *    with a bootstrap_grant. UI shows "invitation sent" and skips the
 *    access-list refresh (the user won't appear until they accept).
 *
 * @deprecated Use `InviteWorkspaceMemberResult`. Kept permanently.
 */
export type InviteProjectMemberResult =
  | ProjectAccessMember
  | {
      status: 'invited';
      email: string;
      invite_id: string;
      project_role: ProjectRole;
      message: string;
      /** Public invite link — share manually when email delivery is skipped. */
      invite_url: string;
      /** false = invite email skipped (e.g. no email provider configured) or failed. */
      email_sent: boolean;
      email_skip_reason: string | null;
    };

/** The workspace name of {@link InviteProjectMemberResult}: the same type. */
export type InviteWorkspaceMemberResult = InviteProjectMemberResult;

export function isInviteSent(
  r: InviteProjectMemberResult,
): r is Extract<InviteProjectMemberResult, { status: 'invited' }> {
  return 'status' in r && r.status === 'invited';
}

/**
 * @deprecated Use `inviteWorkspaceMember`: membership is access. Kept permanently.
 */
export async function inviteProjectMember(
  projectId: string,
  email: string,
  role: ProjectRole,
  /** Optional ISO-8601 time-bound: the granted role auto-revokes at this instant
   *  once the invitee joins. Omit / null for a permanent grant. */
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.post<InviteProjectMemberResult>(
      `/workspaces/${projectId}/access/invite`,
      { email, role, ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}) },
    ),
  );
}

// ── Pending project invites (non-Kortix users who haven't signed up yet) ──

/** Pending account-invitation that bootstraps into THIS project on accept.
 *  Shape mirrors the backend GET /access/pending-invites response.
 *
 *  `expires_at` here is the *grant's* time-bounded clock (auto-revoke once
 *  they're in). `invite_expires_at` is the *invitation* clock — after that
 *  the user can't redeem the link and needs a resend.
 *
 * @deprecated Use `PendingWorkspaceInvite`. Kept permanently.
 */
export interface PendingProjectInvite {
  invite_id: string;
  email: string;
  project_role: ProjectRole;
  expires_at: string | null;
  invited_by_email: string | null;
  created_at: string;
  invite_expires_at: string;
  invite_expired: boolean;
}

/** The workspace name of {@link PendingProjectInvite}: the same type. */
export type PendingWorkspaceInvite = PendingProjectInvite;

export async function listPendingWorkspaceInvites(projectId: string) {
  return unwrap(
    await backendApi.get<{ pending: PendingProjectInvite[] }>(
      `/workspaces/${projectId}/access/pending-invites`,
    ),
  );
}

/** @deprecated Use `listPendingWorkspaceInvites`. Kept permanently. */
export const listPendingProjectInvites = listPendingWorkspaceInvites;

export async function revokePendingWorkspaceInvite(projectId: string, inviteId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean; invitation_cancelled: boolean }>(
      `/workspaces/${projectId}/access/pending-invites/${inviteId}`,
    ),
  );
}

/** @deprecated Use `revokePendingWorkspaceInvite`. Kept permanently. */
export const revokePendingProjectInvite = revokePendingWorkspaceInvite;

/** @deprecated Use `ResendWorkspaceInviteResult`. Kept permanently. */
export interface ResendProjectInviteResult {
  ok: boolean;
  expires_at: string;
  invite_url: string;
  email_sent: boolean;
  email_skip_reason: string | null;
}

/** The workspace name of {@link ResendProjectInviteResult}: the same type. */
export type ResendWorkspaceInviteResult = ResendProjectInviteResult;

export async function resendPendingWorkspaceInvite(projectId: string, inviteId: string) {
  return unwrap(
    await backendApi.post<ResendProjectInviteResult>(
      `/workspaces/${projectId}/access/pending-invites/${inviteId}/resend`,
    ),
  );
}

/** @deprecated Use `resendPendingWorkspaceInvite`. Kept permanently. */
export const resendPendingProjectInvite = resendPendingWorkspaceInvite;

// ── IAM V2: project ⇄ group attachments ────────────────────────────────────

/** @deprecated Use `WorkspaceGroupGrant`. Kept permanently. */
export interface ProjectGroupGrant {
  group_id: string;
  group_name: string;
  role: ProjectRole;
  granted_by: string | null;
  created_at: string;
  /** Auto-revoke timestamp (ISO). null = permanent. */
  expires_at?: string | null;
  /** Total members in this group. */
  member_count?: number;
  /** Members who are account owners/admins — they get implicit Manager
   *  on every project, so this grant's role doesn't apply to them. */
  override_count?: number;
}

/** The workspace name of {@link ProjectGroupGrant}: the same type. */
export type WorkspaceGroupGrant = ProjectGroupGrant;

export async function listWorkspaceGroupGrants(projectId: string) {
  return unwrap(
    await backendApi.get<{ grants: ProjectGroupGrant[] }>(
      `/workspaces/${projectId}/group-grants`,
    ),
  );
}

/** @deprecated Use `listWorkspaceGroupGrants`. Kept permanently. */
export const listProjectGroupGrants = listWorkspaceGroupGrants;

export async function attachGroupToWorkspace(
  projectId: string,
  groupId: string,
  role: ProjectRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.post<{ project_id: string; group_id: string; role: ProjectRole }>(
      `/workspaces/${projectId}/group-grants`,
      // undefined = field omitted (don't touch); null = clear expiry.
      expiresAt === undefined
        ? { group_id: groupId, role }
        : { group_id: groupId, role, expires_at: expiresAt },
    ),
  );
}

/** @deprecated Use `attachGroupToWorkspace`. Kept permanently. */
export const attachGroupToProject = attachGroupToWorkspace;

export async function updateWorkspaceGroupGrant(
  projectId: string,
  groupId: string,
  role: ProjectRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.patch<{ project_id: string; group_id: string; role: ProjectRole }>(
      `/workspaces/${projectId}/group-grants/${groupId}`,
      expiresAt === undefined ? { role } : { role, expires_at: expiresAt },
    ),
  );
}

/** @deprecated Use `updateWorkspaceGroupGrant`. Kept permanently. */
export const updateProjectGroupGrant = updateWorkspaceGroupGrant;

export async function detachGroupFromWorkspace(projectId: string, groupId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${projectId}/group-grants/${groupId}`,
    ),
  );
}

/** @deprecated Use `detachGroupFromWorkspace`. Kept permanently. */
export const detachGroupFromProject = detachGroupFromWorkspace;

// ─── Per-resource (agent/skill/secret) scoping ──────────────────────────────

export type ResourceGrantType = 'agent' | 'skill' | 'secret';

/**
 * A grantable resource (agent name / skill slug) discovered from the repo.
 *
 * @deprecated Use `WorkspaceResourceItem`. Kept permanently.
 */
export interface ProjectResourceItem {
  /** Stable grant key — agent name / skill slug. */
  id: string;
  /** Display name. */
  name: string;
  description: string | null;
}

/** The workspace name of {@link ProjectResourceItem}: the same type. */
export type WorkspaceResourceItem = ProjectResourceItem;

/** An agent resource, enriched with its DECLARED scope so the grant UI can
 *  preview the blast radius of an assignment (the inheritance pyramid): assigning
 *  the agent also grants these secrets + connectors. `'all'` = every one the
 *  assignee can already see (nothing extra inherited).
 *
 * @deprecated Use `WorkspaceAgentResourceItem`. Kept permanently.
 */
export interface ProjectAgentResourceItem extends ProjectResourceItem {
  declares?: { secrets: string[] | 'all'; connectors: string[] | 'all' };
}

/** The workspace name of {@link ProjectAgentResourceItem}: the same type. */
export type WorkspaceAgentResourceItem = ProjectAgentResourceItem;

/** @deprecated Use `WorkspaceResourceGrant`. Kept permanently. */
export interface ProjectResourceGrant {
  grant_id: string;
  resource_type: ResourceGrantType;
  resource_id: string;
  /** `project` = everyone with access to the project (`principal_id` is the
   *  project id). */
  principal_type: 'member' | 'group' | 'project';
  principal_id: string;
  /** Resolved label — member email, group name, or the project's name. */
  principal_label: string;
  granted_by: string | null;
  created_at: string;
  expires_at: string | null;
  /** true = the scoped agent/skill no longer exists (renamed/deleted) — the
   *  grant is inert and the restriction has lapsed; remove or re-point it. */
  orphaned?: boolean;
}

/** The workspace name of {@link ProjectResourceGrant}: the same type. */
export type WorkspaceResourceGrant = ProjectResourceGrant;

/** @deprecated Use `WorkspaceResourceGrantsResponse`. Kept permanently. */
export interface ProjectResourceGrantsResponse {
  resources: {
    agents: ProjectAgentResourceItem[];
    skills: ProjectResourceItem[];
    /** Secret sharing was retired (a secret is always project-wide; the only
     *  access gate is the agent-side `secrets` grant) — never populated, kept
     *  optional for older API responses. */
    secrets?: ProjectResourceItem[];
  };
  grants: ProjectResourceGrant[];
}

/** The workspace name of {@link ProjectResourceGrantsResponse}: the same type. */
export type WorkspaceResourceGrantsResponse = ProjectResourceGrantsResponse;

export async function listWorkspaceResourceGrants(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectResourceGrantsResponse>(
      `/workspaces/${projectId}/resource-grants`,
    ),
  );
}

/** @deprecated Use `listWorkspaceResourceGrants`. Kept permanently. */
export const listProjectResourceGrants = listWorkspaceResourceGrants;

export async function createWorkspaceResourceGrant(
  projectId: string,
  input: {
    resourceType: ResourceGrantType;
    resourceId: string;
    principalType: 'member' | 'group';
    principalId: string;
    expiresAt?: string | null;
  },
) {
  return unwrap(
    await backendApi.post<{ grant_id: string }>(`/workspaces/${projectId}/resource-grants`, {
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      principal_type: input.principalType,
      principal_id: input.principalId,
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    }),
  );
}

/** @deprecated Use `createWorkspaceResourceGrant`. Kept permanently. */
export const createProjectResourceGrant = createWorkspaceResourceGrant;

export async function deleteWorkspaceResourceGrant(projectId: string, grantId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${projectId}/resource-grants/${grantId}`,
    ),
  );
}

/** @deprecated Use `deleteWorkspaceResourceGrant`. Kept permanently. */
export const deleteProjectResourceGrant = deleteWorkspaceResourceGrant;

// ─── Approvals (APPROVE / ASK / BLOCK inbox) ────────────────────────────────

/** A connector call a policy gated as `require_approval`, still awaiting a
 *  human decision. */
export interface PendingApproval {
  execution_id: string;
  action: string;
  risk: string | null;
  session_id: string | null;
  requested_by: string | null;
  requested_by_email: string | null;
  requested_at: string;
  detail: Record<string, unknown> | null;
  /** When the approval stops being decidable. Null: never. Absent on older servers. */
  expires_at?: string | null;
}

export interface PendingApprovalsResponse {
  count: number;
  approvals: PendingApproval[];
}

/** The manager inbox of gated actions awaiting approve/deny. */
export async function listPendingApprovals(projectId: string, options?: { showErrors?: boolean }) {
  return unwrap(
    await backendApi.get<PendingApprovalsResponse>(`/workspaces/${projectId}/approvals`, {
      showErrors: options?.showErrors,
    }),
  );
}

/** Per-session pending-approval summary for the sidebar "needs input" badge:
 *  `sessions` maps a (Kortix) session id → count of actions awaiting a decision.
 *  A manager sees every session; others only the ones they launched. */
export interface SessionsNeedingInputResponse {
  total: number;
  sessions: Record<string, number>;
}

export async function listSessionsNeedingInput(
  projectId: string,
  options?: { showErrors?: boolean },
) {
  return unwrap(
    await backendApi.get<SessionsNeedingInputResponse>(
      `/workspaces/${projectId}/approvals/needs-input`,
      { showErrors: options?.showErrors },
    ),
  );
}

export interface ResolveApprovalOptions {
  /** A message to the agent, delivered with the decision ("deny — reword the
   *  second paragraph"). The session continues with it as instructions. */
  note?: string | null;
}

/** Resolve a pending approval. Allowed for a project manager or the session
 *  launcher; approve lets the action proceed on retry, deny records a refusal. */
// A decision applies to exactly the call that asked for it. The `scope`
// parameter ('session' / 'session_all') was REMOVED: a one-click "stop asking"
// pre-authorised every later call of a tool regardless of its arguments, which
// is precisely what an approval gate exists to prevent. To run a tool
// unattended, author an `always_run` policy rule instead.
export async function resolveApproval(
  projectId: string,
  executionId: string,
  decision: 'approve' | 'deny',
  options: ResolveApprovalOptions = {},
) {
  const note = options.note?.trim();
  return unwrap(
    await backendApi.post<{ ok: boolean }>(`/workspaces/${projectId}/approvals/${executionId}`, {
      decision,
      ...(note ? { note } : {}),
    }),
  );
}
