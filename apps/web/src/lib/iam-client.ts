// Client wrappers for /v1/accounts/:accountId/iam/* — groups, policies,
// roles, super-admin promotion, and effective-permissions probe.

import { backendApi } from '@/lib/api-client';

export type ResourceType =
  | 'account'
  | 'project'
  | 'sandbox'
  | 'trigger'
  | 'channel'
  | 'member'
  | 'group';

export type PrincipalType = 'member' | 'group' | 'token';

export interface AccountGroup {
  group_id: string;
  name: string;
  description: string | null;
  source: 'manual' | 'scim';
  external_id?: string | null;
  member_count?: number;
  policy_count?: number;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  user_id: string;
  added_at: string;
  added_by: string | null;
}

export interface IamRole {
  role_id: string;
  key: string;
  name: string;
  description: string | null;
  resource_type: ResourceType;
  is_system: boolean;
  account_id: string | null;
}

export type PolicyEffect = 'allow' | 'deny';

export interface IamPolicy {
  policy_id: string;
  principal_type: PrincipalType;
  principal_id: string;
  scope_type: ResourceType;
  scope_id: string | null;
  role_id: string;
  effect: PolicyEffect;
  created_by: string | null;
  created_at: string;
}

export interface EffectivePermissionProbe {
  allowed: boolean;
  reason: string | null;
  action: string;
  resource_type: ResourceType;
}

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }) {
  if (!response.success || response.data === undefined) {
    throw response.error || new Error('Unexpected empty response');
  }
  return response.data;
}

// ─── Groups ────────────────────────────────────────────────────────────────

export async function listGroups(accountId: string) {
  return unwrap(
    await backendApi.get<{ groups: AccountGroup[] }>(`/accounts/${accountId}/iam/groups`),
  ).groups;
}

export async function getGroup(accountId: string, groupId: string) {
  return unwrap(
    await backendApi.get<AccountGroup>(`/accounts/${accountId}/iam/groups/${groupId}`),
  );
}

export async function createGroup(accountId: string, input: { name: string; description?: string }) {
  return unwrap(
    await backendApi.post<AccountGroup>(`/accounts/${accountId}/iam/groups`, input, {
      showErrors: false,
    }),
  );
}

export async function updateGroup(
  accountId: string,
  groupId: string,
  patch: { name?: string; description?: string | null },
) {
  return unwrap(
    await backendApi.patch<AccountGroup>(
      `/accounts/${accountId}/iam/groups/${groupId}`,
      patch,
    ),
  );
}

export async function deleteGroup(accountId: string, groupId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/groups/${groupId}`,
    ),
  );
}

export async function listGroupMembers(accountId: string, groupId: string) {
  return unwrap(
    await backendApi.get<{ members: GroupMember[] }>(
      `/accounts/${accountId}/iam/groups/${groupId}/members`,
    ),
  ).members;
}

export async function addGroupMembers(accountId: string, groupId: string, userIds: string[]) {
  return unwrap(
    await backendApi.post<{ added: number }>(
      `/accounts/${accountId}/iam/groups/${groupId}/members`,
      { userIds },
    ),
  );
}

export async function removeGroupMember(accountId: string, groupId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ removed: boolean }>(
      `/accounts/${accountId}/iam/groups/${groupId}/members/${userId}`,
    ),
  );
}

export interface MemberGroupSummary {
  group_id: string;
  name: string;
  added_at: string;
}

/** Groups the given user belongs to within the account. Reverse of
 *  listGroupMembers — backs the "via groups" panel on member detail. */
export async function listMemberGroups(accountId: string, userId: string) {
  return unwrap(
    await backendApi.get<{ groups: MemberGroupSummary[] }>(
      `/accounts/${accountId}/iam/members/${userId}/groups`,
    ),
  ).groups;
}

// ─── Policies ──────────────────────────────────────────────────────────────

export interface ListPoliciesFilter {
  principalType?: PrincipalType;
  principalId?: string;
  scopeType?: ResourceType;
  scopeId?: string | null;
}

export async function listPolicies(accountId: string, filter: ListPoliciesFilter = {}) {
  const params = new URLSearchParams();
  if (filter.principalType) params.set('principalType', filter.principalType);
  if (filter.principalId) params.set('principalId', filter.principalId);
  if (filter.scopeType) params.set('scopeType', filter.scopeType);
  if (filter.scopeId !== undefined) {
    params.set('scopeId', filter.scopeId === null ? 'null' : filter.scopeId);
  }
  const qs = params.toString();
  return unwrap(
    await backendApi.get<{ policies: IamPolicy[] }>(
      `/accounts/${accountId}/iam/policies${qs ? `?${qs}` : ''}`,
    ),
  ).policies;
}

export async function createPolicy(
  accountId: string,
  input: {
    principalType: PrincipalType;
    principalId: string;
    scopeType: ResourceType;
    scopeId?: string | null;
    roleId: string;
    effect?: PolicyEffect;
  },
) {
  return unwrap(
    await backendApi.post<IamPolicy>(`/accounts/${accountId}/iam/policies`, input, {
      showErrors: false,
    }),
  );
}

export async function updatePolicy(
  accountId: string,
  policyId: string,
  input: {
    scopeType: ResourceType;
    scopeId?: string | null;
    roleId: string;
    effect: PolicyEffect;
  },
) {
  return unwrap(
    await backendApi.patch<IamPolicy>(
      `/accounts/${accountId}/iam/policies/${policyId}`,
      input,
      { showErrors: false },
    ),
  );
}

export async function deletePolicy(accountId: string, policyId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/policies/${policyId}`,
    ),
  );
}

// ─── Roles ─────────────────────────────────────────────────────────────────

export async function listRoles(accountId: string) {
  return unwrap(
    await backendApi.get<{ roles: IamRole[] }>(`/accounts/${accountId}/iam/roles`),
  ).roles;
}

export async function getRolePermissions(accountId: string, roleId: string) {
  return unwrap(
    await backendApi.get<{ role_id: string; key: string; actions: string[] }>(
      `/accounts/${accountId}/iam/roles/${roleId}/permissions`,
    ),
  );
}

export interface ActionCatalogEntry {
  action: string;
  label: string;
  resource_type: ResourceType;
}

export async function listActions(accountId: string) {
  return unwrap(
    await backendApi.get<{ actions: ActionCatalogEntry[] }>(
      `/accounts/${accountId}/iam/actions`,
    ),
  ).actions;
}

export async function getRoleUsage(accountId: string, roleId: string) {
  return unwrap(
    await backendApi.get<{ role_id: string; policy_count: number }>(
      `/accounts/${accountId}/iam/roles/${roleId}/usage`,
    ),
  );
}

export async function createRole(
  accountId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    resourceType: ResourceType;
    actions: string[];
  },
) {
  return unwrap(
    await backendApi.post<IamRole>(`/accounts/${accountId}/iam/roles`, input, {
      showErrors: false,
    }),
  );
}

export async function updateRole(
  accountId: string,
  roleId: string,
  patch: { name?: string; description?: string | null },
) {
  return unwrap(
    await backendApi.patch<IamRole>(
      `/accounts/${accountId}/iam/roles/${roleId}`,
      patch,
      { showErrors: false },
    ),
  );
}

export async function updateRolePermissions(
  accountId: string,
  roleId: string,
  actions: string[],
) {
  return unwrap(
    await backendApi.put<{ role_id: string; actions: string[] }>(
      `/accounts/${accountId}/iam/roles/${roleId}/permissions`,
      { actions },
      { showErrors: false },
    ),
  );
}

export async function deleteRole(accountId: string, roleId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/roles/${roleId}`,
      { showErrors: false },
    ),
  );
}

// ─── Super-admin promotion ─────────────────────────────────────────────────

export async function setMemberSuperAdmin(
  accountId: string,
  userId: string,
  isSuperAdmin: boolean,
) {
  return unwrap(
    await backendApi.patch<{ user_id: string; is_super_admin: boolean }>(
      `/accounts/${accountId}/iam/members/${userId}/super-admin`,
      { isSuperAdmin },
    ),
  );
}

// ─── Audit log ─────────────────────────────────────────────────────────────

export interface AuditEvent {
  event_id: string;
  occurred_at: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

export interface ListAuditFilter {
  /** Prefix or exact match on action string ("iam.policy" matches every
   *  iam.policy.* event; "iam.policy.create" matches exact). */
  action?: string;
  /** ISO datetime — events at or after. */
  since?: string;
  /** Cursor from a previous response's next_cursor. */
  cursor?: string;
  /** 1..200, default 50. */
  limit?: number;
}

export async function listAuditEvents(accountId: string, filter: ListAuditFilter = {}) {
  const params = new URLSearchParams();
  if (filter.action) params.set('action', filter.action);
  if (filter.since) params.set('since', filter.since);
  if (filter.cursor) params.set('cursor', filter.cursor);
  if (filter.limit) params.set('limit', String(filter.limit));
  const qs = params.toString();
  return unwrap(
    await backendApi.get<{ events: AuditEvent[]; next_cursor: string | null }>(
      `/accounts/${accountId}/audit${qs ? `?${qs}` : ''}`,
    ),
  );
}

// ─── Effective permissions probe ───────────────────────────────────────────

export async function probeEffectivePermission(
  accountId: string,
  userId: string,
  args: { action: string; resourceType?: ResourceType; resourceId?: string },
) {
  const params = new URLSearchParams();
  params.set('action', args.action);
  if (args.resourceType) params.set('resourceType', args.resourceType);
  if (args.resourceId) params.set('resourceId', args.resourceId);
  return unwrap(
    await backendApi.get<EffectivePermissionProbe>(
      `/accounts/${accountId}/iam/members/${userId}/effective?${params.toString()}`,
    ),
  );
}

export interface PermissionProbeInput {
  action: string;
  resourceType?: ResourceType;
  resourceId?: string;
}

export interface PermissionProbeResult {
  action: string;
  resource_type: ResourceType;
  resource_id: string | null;
  allowed: boolean;
  reason: string | null;
}

/**
 * Batch variant — answers come back in the same order as the input. Use this
 * when a single render needs more than ~3 probes (capabilities panel,
 * multi-button gating on the same page). The server dedupes duplicate
 * (action, target) pairs internally.
 */
export async function probeEffectivePermissions(
  accountId: string,
  userId: string,
  probes: PermissionProbeInput[],
) {
  if (probes.length === 0) return [] as PermissionProbeResult[];
  return unwrap(
    await backendApi.post<{ results: PermissionProbeResult[] }>(
      `/accounts/${accountId}/iam/members/${userId}/effective:batch`,
      { probes },
    ),
  ).results;
}
