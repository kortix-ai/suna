// Workspace access — members, access requests, workspace invites, and group grants.

import { backendApi, type ApiClientOptions } from '../../http/api-client';
import { unwrap, type AccountRole, type WorkspaceRole } from './shared';

export interface WorkspaceGroupAccessSource {
  group_id: string;
  group_name: string;
  role: WorkspaceRole;
}

export interface WorkspaceAccessMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  workspace_role: WorkspaceRole | null;
  effective_workspace_role: WorkspaceRole | null;
  has_implicit_access: boolean;
  /** Which path produced effective_workspace_role. 'implicit' = account
   *  owner/admin; 'direct' = explicit workspace_members row; 'group' =
   *  inherited via a workspace_group_grants attachment. null = no access. */
  effective_source?: 'implicit' | 'direct' | 'group' | null;
  /** Every group attachment that includes this user, sorted by role
   *  desc. Used to label "via X group" on the row. */
  group_sources?: WorkspaceGroupAccessSource[];
  joined_at: string;
  granted_by: string | null;
  granted_at: string | null;
  updated_at: string | null;
  /** Auto-revoke timestamp for the DIRECT grant (ISO). null = permanent
   *  or no direct grant. */
  expires_at?: string | null;
}

export interface WorkspaceAccessResponse {
  workspace_id: string;
  account_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: WorkspaceAccessMember[];
}

export interface WorkspaceAccessRequest {
  request_id: string;
  account_id: string;
  workspace_id: string;
  requester_user_id: string;
  requester_email: string;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RequestWorkspaceAccessResult =
  | { status: 'created'; request: WorkspaceAccessRequest }
  | { status: 'pending'; request: WorkspaceAccessRequest }
  | { status: 'already_has_access'; workspace_id: string };

export async function requestWorkspaceAccess(workspaceId: string, message?: string) {
  return unwrap(
    await backendApi.post<RequestWorkspaceAccessResult>(
      `/workspaces/${workspaceId}/access-requests`,
      { message: message?.trim() || undefined },
      { showErrors: false },
    ),
  );
}

export async function listWorkspaceAccessRequests(workspaceId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<{ requests: WorkspaceAccessRequest[] }>(
      `/workspaces/${workspaceId}/access-requests`,
      options,
    ),
  );
}

export async function approveWorkspaceAccessRequest(
  workspaceId: string,
  requestId: string,
  role: WorkspaceRole = 'member',
) {
  return unwrap(
    await backendApi.post<{
      request: WorkspaceAccessRequest;
      member: WorkspaceAccessMember;
    }>(`/workspaces/${workspaceId}/access-requests/${requestId}/approve`, { role }),
  );
}

export async function rejectWorkspaceAccessRequest(workspaceId: string, requestId: string) {
  return unwrap(
    await backendApi.post<{ request: WorkspaceAccessRequest }>(
      `/workspaces/${workspaceId}/access-requests/${requestId}/reject`,
      {},
    ),
  );
}

export async function listWorkspaceAccess(workspaceId: string) {
  return unwrap(
    await backendApi.get<WorkspaceAccessResponse>(
      `/workspaces/${workspaceId}/access`,
    ),
  );
}

export async function updateWorkspaceAccess(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
) {
  return unwrap(
    await backendApi.put<WorkspaceAccessMember>(
      `/workspaces/${workspaceId}/access/${userId}`,
      { role },
    ),
  );
}

export async function revokeWorkspaceAccess(workspaceId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${workspaceId}/access/${userId}`,
    ),
  );
}

/** Two-shape response:
 *  - User had a Kortix account already → WorkspaceAccessMember row was
 *    inserted/updated; UI refreshes the access list and shows them.
 *  - User had no Kortix account → an account invitation was created
 *    with a bootstrap_grant. UI shows "invitation sent" and skips the
 *    access-list refresh (the user won't appear until they accept). */
export type InviteWorkspaceMemberResult =
  | WorkspaceAccessMember
  | {
      status: 'invited';
      email: string;
      invite_id: string;
      workspace_role: WorkspaceRole;
      message: string;
      /** Public invite link — share manually when email delivery is skipped. */
      invite_url: string;
      /** false = invite email skipped (e.g. no email provider configured) or failed. */
      email_sent: boolean;
      email_skip_reason: string | null;
    };

export function isInviteSent(
  r: InviteWorkspaceMemberResult,
): r is Extract<InviteWorkspaceMemberResult, { status: 'invited' }> {
  return 'status' in r && r.status === 'invited';
}

export async function inviteWorkspaceMember(
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
  /** Optional ISO-8601 time-bound: the granted role auto-revokes at this instant
   *  once the invitee joins. Omit / null for a permanent grant. */
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.post<InviteWorkspaceMemberResult>(
      `/workspaces/${workspaceId}/access/invite`,
      { email, role, ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}) },
    ),
  );
}

// ── Pending workspace invites (non-Kortix users who haven't signed up yet) ──

/** Pending account-invitation that bootstraps into THIS workspace on accept.
 *  Shape mirrors the backend GET /access/pending-invites response.
 *
 *  `expires_at` here is the *grant's* time-bounded clock (auto-revoke once
 *  they're in). `invite_expires_at` is the *invitation* clock — after that
 *  the user can't redeem the link and needs a resend. */
export interface PendingWorkspaceInvite {
  invite_id: string;
  email: string;
  workspace_role: WorkspaceRole;
  expires_at: string | null;
  invited_by_email: string | null;
  created_at: string;
  invite_expires_at: string;
  invite_expired: boolean;
}

export async function listPendingWorkspaceInvites(workspaceId: string) {
  return unwrap(
    await backendApi.get<{ pending: PendingWorkspaceInvite[] }>(
      `/workspaces/${workspaceId}/access/pending-invites`,
    ),
  );
}

export async function revokePendingWorkspaceInvite(workspaceId: string, inviteId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean; invitation_cancelled: boolean }>(
      `/workspaces/${workspaceId}/access/pending-invites/${inviteId}`,
    ),
  );
}

export interface ResendWorkspaceInviteResult {
  ok: boolean;
  expires_at: string;
  invite_url: string;
  email_sent: boolean;
  email_skip_reason: string | null;
}

export async function resendPendingWorkspaceInvite(workspaceId: string, inviteId: string) {
  return unwrap(
    await backendApi.post<ResendWorkspaceInviteResult>(
      `/workspaces/${workspaceId}/access/pending-invites/${inviteId}/resend`,
    ),
  );
}

// ── IAM V2: workspace ⇄ group attachments ────────────────────────────────────

export interface WorkspaceGroupGrant {
  group_id: string;
  group_name: string;
  role: WorkspaceRole;
  granted_by: string | null;
  created_at: string;
  /** Auto-revoke timestamp (ISO). null = permanent. */
  expires_at?: string | null;
  /** Total members in this group. */
  member_count?: number;
  /** Members who are account owners/admins — they get implicit Manager
   *  on every workspace, so this grant's role doesn't apply to them. */
  override_count?: number;
}

export async function listWorkspaceGroupGrants(workspaceId: string) {
  return unwrap(
    await backendApi.get<{ grants: WorkspaceGroupGrant[] }>(
      `/workspaces/${workspaceId}/group-grants`,
    ),
  );
}

export async function attachGroupToWorkspace(
  workspaceId: string,
  groupId: string,
  role: WorkspaceRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.post<{ workspace_id: string; group_id: string; role: WorkspaceRole }>(
      `/workspaces/${workspaceId}/group-grants`,
      // undefined = field omitted (don't touch); null = clear expiry.
      expiresAt === undefined
        ? { group_id: groupId, role }
        : { group_id: groupId, role, expires_at: expiresAt },
    ),
  );
}

export async function updateWorkspaceGroupGrant(
  workspaceId: string,
  groupId: string,
  role: WorkspaceRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.patch<{ workspace_id: string; group_id: string; role: WorkspaceRole }>(
      `/workspaces/${workspaceId}/group-grants/${groupId}`,
      expiresAt === undefined ? { role } : { role, expires_at: expiresAt },
    ),
  );
}

export async function detachGroupFromWorkspace(workspaceId: string, groupId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${workspaceId}/group-grants/${groupId}`,
    ),
  );
}

// ─── Per-resource (agent/skill/secret) scoping ──────────────────────────────

export type ResourceGrantType = 'agent' | 'skill' | 'secret';

/** A grantable resource (agent name / skill slug) discovered from the repo. */
export interface WorkspaceResourceItem {
  /** Stable grant key — agent name / skill slug. */
  id: string;
  /** Display name. */
  name: string;
  description: string | null;
}

/** An agent resource, enriched with its DECLARED scope so the grant UI can
 *  preview the blast radius of an assignment (the inheritance pyramid): assigning
 *  the agent also grants these secrets + connectors. `'all'` = every one the
 *  assignee can already see (nothing extra inherited). */
export interface WorkspaceAgentResourceItem extends WorkspaceResourceItem {
  declares?: { secrets: string[] | 'all'; connectors: string[] | 'all' };
}

export interface WorkspaceResourceGrant {
  grant_id: string;
  resource_type: ResourceGrantType;
  resource_id: string;
  principal_type: 'member' | 'group';
  principal_id: string;
  /** Resolved label — member email or group name. */
  principal_label: string;
  granted_by: string | null;
  created_at: string;
  expires_at: string | null;
  /** true = the scoped agent/skill no longer exists (renamed/deleted) — the
   *  grant is inert and the restriction has lapsed; remove or re-point it. */
  orphaned?: boolean;
}

export interface WorkspaceResourceGrantsResponse {
  resources: {
    agents: WorkspaceAgentResourceItem[];
    skills: WorkspaceResourceItem[];
    /** Secret sharing was retired (a secret is always workspace-wide; the only
     *  access gate is the agent-side `secrets` grant) — never populated, kept
     *  optional for older API responses. */
    secrets?: WorkspaceResourceItem[];
  };
  grants: WorkspaceResourceGrant[];
}

export async function listWorkspaceResourceGrants(workspaceId: string) {
  return unwrap(
    await backendApi.get<WorkspaceResourceGrantsResponse>(
      `/workspaces/${workspaceId}/resource-grants`,
    ),
  );
}

export async function createWorkspaceResourceGrant(
  workspaceId: string,
  input: {
    resourceType: ResourceGrantType;
    resourceId: string;
    principalType: 'member' | 'group';
    principalId: string;
    expiresAt?: string | null;
  },
) {
  return unwrap(
    await backendApi.post<{ grant_id: string }>(`/workspaces/${workspaceId}/resource-grants`, {
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      principal_type: input.principalType,
      principal_id: input.principalId,
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    }),
  );
}

export async function deleteWorkspaceResourceGrant(workspaceId: string, grantId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${workspaceId}/resource-grants/${grantId}`,
    ),
  );
}

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
}

export interface PendingApprovalsResponse {
  count: number;
  approvals: PendingApproval[];
}

/** The manager inbox of gated actions awaiting approve/deny. */
export async function listPendingApprovals(workspaceId: string, options?: { showErrors?: boolean }) {
  return unwrap(
    await backendApi.get<PendingApprovalsResponse>(`/workspaces/${workspaceId}/approvals`, {
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
  workspaceId: string,
  options?: { showErrors?: boolean },
) {
  return unwrap(
    await backendApi.get<SessionsNeedingInputResponse>(
      `/workspaces/${workspaceId}/approvals/needs-input`,
      { showErrors: options?.showErrors },
    ),
  );
}

/** Resolve a pending approval. Allowed for a workspace manager or the session
 *  launcher; approve lets the action proceed on retry, deny records a refusal. */
// A decision applies to exactly the call that asked for it. The `scope`
// parameter ('session' / 'session_all') was REMOVED: a one-click "stop asking"
// pre-authorised every later call of a tool regardless of its arguments, which
// is precisely what an approval gate exists to prevent. To run a tool
// unattended, author an `always_run` policy rule instead.
export async function resolveApproval(
  workspaceId: string,
  executionId: string,
  decision: 'approve' | 'deny',
) {
  return unwrap(
    await backendApi.post<{ ok: boolean }>(`/workspaces/${workspaceId}/approvals/${executionId}`, {
      decision,
    }),
  );
}
