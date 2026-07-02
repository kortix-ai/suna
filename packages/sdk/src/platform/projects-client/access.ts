// Project access — members, access requests, project invites, and group grants.

import { backendApi, type ApiClientOptions } from '../api-client';
import { unwrap, type AccountRole, type ProjectRole } from './shared';

export interface ProjectGroupAccessSource {
  group_id: string;
  group_name: string;
  role: ProjectRole;
}

export interface ProjectAccessMember {
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

export interface ProjectAccessResponse {
  project_id: string;
  account_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: ProjectAccessMember[];
}

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

export type RequestProjectAccessResult =
  | { status: 'created'; request: ProjectAccessRequest }
  | { status: 'pending'; request: ProjectAccessRequest }
  | { status: 'already_has_access'; project_id: string };

export async function requestProjectAccess(projectId: string, message?: string) {
  return unwrap(
    await backendApi.post<RequestProjectAccessResult>(
      `/projects/${projectId}/access-requests`,
      { message: message?.trim() || undefined },
      { showErrors: false },
    ),
  );
}

export async function listProjectAccessRequests(projectId: string, options?: ApiClientOptions) {
  return unwrap(
    await backendApi.get<{ requests: ProjectAccessRequest[] }>(
      `/projects/${projectId}/access-requests`,
      options,
    ),
  );
}

export async function approveProjectAccessRequest(
  projectId: string,
  requestId: string,
  role: ProjectRole = 'user',
) {
  return unwrap(
    await backendApi.post<{
      request: ProjectAccessRequest;
      member: ProjectAccessMember;
    }>(`/projects/${projectId}/access-requests/${requestId}/approve`, { role }),
  );
}

export async function rejectProjectAccessRequest(projectId: string, requestId: string) {
  return unwrap(
    await backendApi.post<{ request: ProjectAccessRequest }>(
      `/projects/${projectId}/access-requests/${requestId}/reject`,
      {},
    ),
  );
}

export async function listProjectAccess(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectAccessResponse>(
      `/projects/${projectId}/access`,
    ),
  );
}

export async function updateProjectAccess(
  projectId: string,
  userId: string,
  role: ProjectRole,
) {
  return unwrap(
    await backendApi.put<ProjectAccessMember>(
      `/projects/${projectId}/access/${userId}`,
      { role },
    ),
  );
}

export async function revokeProjectAccess(projectId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/access/${userId}`,
    ),
  );
}

/** Two-shape response:
 *  - User had a Kortix account already → ProjectAccessMember row was
 *    inserted/updated; UI refreshes the access list and shows them.
 *  - User had no Kortix account → an account invitation was created
 *    with a bootstrap_grant. UI shows "invitation sent" and skips the
 *    access-list refresh (the user won't appear until they accept). */
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
      /** false = invite email skipped (e.g. Mailtrap unconfigured) or failed. */
      email_sent: boolean;
      email_skip_reason: string | null;
    };

export function isInviteSent(
  r: InviteProjectMemberResult,
): r is Extract<InviteProjectMemberResult, { status: 'invited' }> {
  return 'status' in r && r.status === 'invited';
}

export async function inviteProjectMember(
  projectId: string,
  email: string,
  role: ProjectRole,
) {
  return unwrap(
    await backendApi.post<InviteProjectMemberResult>(
      `/projects/${projectId}/access/invite`,
      { email, role },
    ),
  );
}

// ── Pending project invites (non-Kortix users who haven't signed up yet) ──

/** Pending account-invitation that bootstraps into THIS project on accept.
 *  Shape mirrors the backend GET /access/pending-invites response.
 *
 *  `expires_at` here is the *grant's* time-bounded clock (auto-revoke once
 *  they're in). `invite_expires_at` is the *invitation* clock — after that
 *  the user can't redeem the link and needs a resend. */
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

export async function listPendingProjectInvites(projectId: string) {
  return unwrap(
    await backendApi.get<{ pending: PendingProjectInvite[] }>(
      `/projects/${projectId}/access/pending-invites`,
    ),
  );
}

export async function revokePendingProjectInvite(projectId: string, inviteId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean; invitation_cancelled: boolean }>(
      `/projects/${projectId}/access/pending-invites/${inviteId}`,
    ),
  );
}

export interface ResendProjectInviteResult {
  ok: boolean;
  expires_at: string;
  invite_url: string;
  email_sent: boolean;
  email_skip_reason: string | null;
}

export async function resendPendingProjectInvite(projectId: string, inviteId: string) {
  return unwrap(
    await backendApi.post<ResendProjectInviteResult>(
      `/projects/${projectId}/access/pending-invites/${inviteId}/resend`,
    ),
  );
}

// ── IAM V2: project ⇄ group attachments ────────────────────────────────────

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

export async function listProjectGroupGrants(projectId: string) {
  return unwrap(
    await backendApi.get<{ grants: ProjectGroupGrant[] }>(
      `/projects/${projectId}/group-grants`,
    ),
  );
}

export async function attachGroupToProject(
  projectId: string,
  groupId: string,
  role: ProjectRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.post<{ project_id: string; group_id: string; role: ProjectRole }>(
      `/projects/${projectId}/group-grants`,
      // undefined = field omitted (don't touch); null = clear expiry.
      expiresAt === undefined
        ? { group_id: groupId, role }
        : { group_id: groupId, role, expires_at: expiresAt },
    ),
  );
}

export async function updateProjectGroupGrant(
  projectId: string,
  groupId: string,
  role: ProjectRole,
  expiresAt?: string | null,
) {
  return unwrap(
    await backendApi.patch<{ project_id: string; group_id: string; role: ProjectRole }>(
      `/projects/${projectId}/group-grants/${groupId}`,
      expiresAt === undefined ? { role } : { role, expires_at: expiresAt },
    ),
  );
}

export async function detachGroupFromProject(projectId: string, groupId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/group-grants/${groupId}`,
    ),
  );
}

// ─── Per-resource (agent/skill/secret) scoping ──────────────────────────────

export type ResourceGrantType = 'agent' | 'skill' | 'secret';

/** A grantable resource (agent name / skill slug) discovered from the repo. */
export interface ProjectResourceItem {
  /** Stable grant key — agent name / skill slug. */
  id: string;
  /** Display name. */
  name: string;
  description: string | null;
}

export interface ProjectResourceGrant {
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

export interface ProjectResourceGrantsResponse {
  resources: {
    agents: ProjectResourceItem[];
    skills: ProjectResourceItem[];
    secrets: ProjectResourceItem[];
  };
  grants: ProjectResourceGrant[];
}

export async function listProjectResourceGrants(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectResourceGrantsResponse>(
      `/projects/${projectId}/resource-grants`,
    ),
  );
}

export async function createProjectResourceGrant(
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
    await backendApi.post<{ grant_id: string }>(`/projects/${projectId}/resource-grants`, {
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      principal_type: input.principalType,
      principal_id: input.principalId,
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    }),
  );
}

export async function deleteProjectResourceGrant(projectId: string, grantId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/projects/${projectId}/resource-grants/${grantId}`,
    ),
  );
}
