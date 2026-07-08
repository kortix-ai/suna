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

/** Scope a policy can target. Superset of ResourceType — adds container
 *  scopes the engine resolves at match time (currently: project_group). */
export type PolicyScopeType = ResourceType | 'project_group';

export type PrincipalType = 'member' | 'group' | 'token';

export interface AccountGroup {
  group_id: string;
  name: string;
  description: string | null;
  source: 'manual' | 'scim';
  external_id?: string | null;
  member_count?: number;
  /** Number of project_group_grants for this group. */
  project_count?: number;
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

/**
 * Optional gating conditions on a policy. The engine evaluates these at
 * request time — a policy whose conditions don't pass is silent (acts as
 * if it didn't exist). Keys compose with AND.
 *
 *   ip_cidrs:    request IP must fall in one of these CIDRs / bare IPs.
 *   require_mfa: session must be MFA-verified (Supabase aal2).
 *
 * Empty object means "no conditions" (always applies).
 */
export interface PolicyConditions {
  ip_cidrs?: string[];
  require_mfa?: boolean;
}

export interface IamPolicy {
  policy_id: string;
  principal_type: PrincipalType;
  principal_id: string;
  scope_type: PolicyScopeType;
  scope_id: string | null;
  role_id: string;
  effect: PolicyEffect;
  conditions: PolicyConditions;
  /** Optional hard expiry. ISO-8601 string. NULL = permanent. */
  expires_at?: string | null;
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

/**
 * All IAM READS go through this instead of `backendApi.get` directly:
 * `showErrors: false` keeps a capability-denied read (403 "You don't have
 * permission to perform this action (policy.read)") out of the GLOBAL error
 * toast. Reads are background queries — when the viewer can't read something,
 * the UI's job is to gate or hide that surface (react-query still exposes
 * `isError` to any component that wants an explicit error state), not to
 * raise a "contact support" toast. Mutations keep full error surfacing —
 * they're user-initiated and their call sites toast specific messages.
 */
function iamGet<T>(path: string) {
  return backendApi.get<T>(path, { showErrors: false });
}

// ─── Groups ────────────────────────────────────────────────────────────────

export async function listGroups(accountId: string) {
  return unwrap(
    await iamGet<{ groups: AccountGroup[] }>(`/accounts/${accountId}/iam/groups`),
  ).groups;
}

export async function getGroup(accountId: string, groupId: string) {
  return unwrap(await iamGet<AccountGroup>(`/accounts/${accountId}/iam/groups/${groupId}`));
}

export async function createGroup(
  accountId: string,
  input: { name: string; description?: string },
) {
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
    await backendApi.patch<AccountGroup>(`/accounts/${accountId}/iam/groups/${groupId}`, patch),
  );
}

export async function deleteGroup(accountId: string, groupId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(`/accounts/${accountId}/iam/groups/${groupId}`),
  );
}

export async function listGroupMembers(accountId: string, groupId: string) {
  return unwrap(
    await iamGet<{ members: GroupMember[] }>(
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

// V2-only: which projects is this group attached to + at what role?
// Backed by GET /accounts/:id/iam/groups/:gid/project-grants. Each row
// can be detached via the per-project DELETE /projects/:pid/group-grants/:gid
// endpoint (already in projects-client as detachGroupFromProject).
export interface GroupProjectGrant {
  project_id: string;
  project_name: string;
  role: 'manager' | 'editor' | 'member';
  granted_by: string | null;
  created_at: string;
  /** Auto-revoke timestamp (ISO). null = permanent. Surfaced from the
   *  backend's project_group_grants.expires_at. */
  expires_at?: string | null;
}

export async function listGroupProjectGrants(accountId: string, groupId: string) {
  return unwrap(
    await iamGet<{ grants: GroupProjectGrant[] }>(
      `/accounts/${accountId}/iam/groups/${groupId}/project-grants`,
    ),
  ).grants;
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
    await iamGet<{ groups: MemberGroupSummary[] }>(
      `/accounts/${accountId}/iam/members/${userId}/groups`,
    ),
  ).groups;
}

// V2-only: which projects can this member reach, at what role, and how?
// `sources` tells the UI why they have access (one or more of):
//   implicit — they're an account owner/admin (manager on every project)
//   direct   — explicit project_members row
//   group    — inherited from a project_group_grants attachment
export interface MemberProjectAccess {
  project_id: string;
  project_name: string;
  role: 'manager' | 'editor' | 'member';
  sources: Array<'implicit' | 'direct' | 'group'>;
}

export async function listMemberProjectAccess(accountId: string, userId: string) {
  return unwrap(
    await iamGet<{ projects: MemberProjectAccess[] }>(
      `/accounts/${accountId}/iam/members/${userId}/project-access`,
    ),
  ).projects;
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
    await iamGet<{ policies: IamPolicy[] }>(
      `/accounts/${accountId}/iam/policies${qs ? `?${qs}` : ''}`,
    ),
  ).policies;
}

export async function createPolicy(
  accountId: string,
  input: {
    principalType: PrincipalType;
    principalId: string;
    scopeType: PolicyScopeType;
    scopeId?: string | null;
    roleId: string;
    effect?: PolicyEffect;
    /** Optional gating conditions. Omit for an unconditional policy. */
    conditions?: PolicyConditions;
    /** Optional hard expiry (ISO-8601). Omit for permanent. */
    expires_at?: string | null;
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
    scopeType: PolicyScopeType;
    scopeId?: string | null;
    roleId: string;
    effect: PolicyEffect;
    /** Omit to leave existing conditions untouched. Pass `{}` to clear. */
    conditions?: PolicyConditions;
    /** Undefined = leave untouched; null = clear expiry; ISO = set. */
    expires_at?: string | null;
  },
) {
  return unwrap(
    await backendApi.patch<IamPolicy>(`/accounts/${accountId}/iam/policies/${policyId}`, input, {
      showErrors: false,
    }),
  );
}

export async function deletePolicy(accountId: string, policyId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/policies/${policyId}`,
    ),
  );
}

export interface BulkDeleteResult {
  deleted: number;
}

export async function bulkDeletePolicies(accountId: string, policyIds: string[]) {
  return unwrap(
    await backendApi.post<BulkDeleteResult>(
      `/accounts/${accountId}/iam/policies:bulk-delete`,
      { policy_ids: policyIds },
      { showErrors: false },
    ),
  );
}

export interface BulkImportEntry {
  principal_type: PrincipalType;
  principal_id: string;
  scope_type: PolicyScopeType;
  scope_id?: string | null;
  /** Reference by role key (not id) so exported JSON is portable
   *  across accounts. */
  role_key: string;
  effect?: PolicyEffect;
  conditions?: PolicyConditions;
  expires_at?: string | null;
}

export interface BulkImportResult {
  attempted: number;
  created: number;
  skipped: number;
  errors: Array<{ index: number; error: string }>;
}

export async function bulkImportPolicies(accountId: string, policies: BulkImportEntry[]) {
  return unwrap(
    await backendApi.post<BulkImportResult>(
      `/accounts/${accountId}/iam/policies:bulk-import`,
      { policies },
      { showErrors: false },
    ),
  );
}

// ─── Roles ─────────────────────────────────────────────────────────────────

export async function listRoles(accountId: string) {
  return unwrap(await iamGet<{ roles: IamRole[] }>(`/accounts/${accountId}/iam/roles`))
    .roles;
}

/** Auto-provisioned agent (service-account) identities — the principal picker for
 *  binding a role to an agent, promoting it to a standing teammate. */
export interface AgentIdentity {
  service_account_id: string;
  name: string;
  project_id: string | null;
  agent_name: string | null;
}

export async function listAgentIdentities(accountId: string) {
  return unwrap(
    await iamGet<{ agents: AgentIdentity[] }>(
      `/accounts/${accountId}/iam/agent-identities`,
    ),
  ).agents;
}

export async function getRolePermissions(accountId: string, roleId: string) {
  return unwrap(
    await iamGet<{ role_id: string; key: string; actions: string[] }>(
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
    await iamGet<{ actions: ActionCatalogEntry[] }>(`/accounts/${accountId}/iam/actions`),
  ).actions;
}

export async function getRoleUsage(accountId: string, roleId: string) {
  return unwrap(
    await iamGet<{ role_id: string; policy_count: number }>(
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
    await backendApi.patch<IamRole>(`/accounts/${accountId}/iam/roles/${roleId}`, patch, {
      showErrors: false,
    }),
  );
}

export async function updateRolePermissions(accountId: string, roleId: string, actions: string[]) {
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
    await backendApi.delete<{ deleted: boolean }>(`/accounts/${accountId}/iam/roles/${roleId}`, {
      showErrors: false,
    }),
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

// ─── SCIM tokens ──────────────────────────────────────────────────────────

export interface ScimToken {
  token_id: string;
  name: string;
  public_prefix: string;
  status: 'active' | 'expired' | 'revoked';
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CreatedScimToken
  extends Omit<ScimToken, 'last_used_at' | 'revoked_at' | 'status'> {
  /** Plaintext bearer — shown ONCE at creation. Never logged or returned again. */
  secret: string;
  /** Path the IdP should configure as its SCIM base URL. */
  scim_base_url: string;
}

export async function listScimTokens(accountId: string) {
  return unwrap(
    await iamGet<{ tokens: ScimToken[] }>(`/accounts/${accountId}/iam/scim/tokens`),
  ).tokens;
}

export async function createScimToken(
  accountId: string,
  input: { name: string; expires_at?: string },
) {
  return unwrap(
    await backendApi.post<CreatedScimToken>(`/accounts/${accountId}/iam/scim/tokens`, input, {
      showErrors: false,
    }),
  );
}

export async function revokeScimToken(accountId: string, tokenId: string) {
  return unwrap(
    await backendApi.delete<{ revoked: boolean }>(
      `/accounts/${accountId}/iam/scim/tokens/${tokenId}`,
    ),
  );
}

// ─── Account MFA enforcement ──────────────────────────────────────────────

export interface MfaRequiredStatus {
  enabled: boolean;
}

export interface MfaRequiredPreview {
  total_members: number;
  members_with_mfa: number;
  /** Members without a verified MFA factor. Super-admins are still listed
   *  (so admins can nudge them) but flagged so the UI can soften the
   *  warning — super-admins remain exempt from enforcement. */
  losers: Array<{
    user_id: string;
    account_role: 'owner' | 'admin' | 'member';
    is_super_admin: boolean;
  }>;
  /** True when nobody would retain access — UI uses this to refuse the
   *  flip before round-tripping to the API. */
  will_lock_out_account: boolean;
}

export async function getMfaRequired(accountId: string) {
  return unwrap(await iamGet<MfaRequiredStatus>(`/accounts/${accountId}/iam/mfa-required`));
}

export async function previewMfaRequired(accountId: string) {
  return unwrap(
    await iamGet<MfaRequiredPreview>(`/accounts/${accountId}/iam/mfa-required/preview`),
  );
}

export async function setMfaRequired(accountId: string, enabled: boolean) {
  return unwrap(
    await backendApi.patch<{ enabled: boolean; unchanged?: boolean }>(
      `/accounts/${accountId}/iam/mfa-required`,
      { enabled },
      { showErrors: false },
    ),
  );
}

// ─── SAML SSO ─────────────────────────────────────────────────────────────

export interface SsoProvider {
  sso_provider_id: string;
  supabase_sso_provider_id: string;
  name: string;
  primary_domain: string;
  group_claim_name: string;
  auto_create_members: boolean;
  auto_provision_groups: boolean;
  created_at: string;
  updated_at: string;
}

export interface SsoGroupMapping {
  mapping_id: string;
  claim_value: string;
  group_id: string;
  group_name: string;
  created_at: string;
}

export async function getSsoProvider(accountId: string) {
  return unwrap(
    await iamGet<{ provider: SsoProvider | null }>(
      `/accounts/${accountId}/iam/sso/provider`,
    ),
  ).provider;
}

export async function upsertSsoProvider(
  accountId: string,
  input: {
    supabase_sso_provider_id: string;
    name: string;
    primary_domain: string;
    group_claim_name?: string;
    auto_create_members?: boolean;
    auto_provision_groups?: boolean;
  },
) {
  return unwrap(
    await backendApi.put<{ provider: SsoProvider }>(
      `/accounts/${accountId}/iam/sso/provider`,
      input,
      { showErrors: false },
    ),
  ).provider;
}

/**
 * Self-serve: register an IdP's SAML metadata (Entra "App Federation Metadata
 * XML", or its URL) with Supabase server-side and store the resulting provider.
 * The admin never touches Supabase. One IdP per account — the API 409s if one
 * already exists.
 */
export async function importSsoProviderFromMetadata(
  accountId: string,
  input: {
    name: string;
    primary_domain: string;
    metadata_xml?: string;
    metadata_url?: string;
    group_claim_name?: string;
    auto_create_members?: boolean;
    auto_provision_groups?: boolean;
    domains?: string[];
  },
) {
  return unwrap(
    await backendApi.post<{ provider: SsoProvider }>(
      `/accounts/${accountId}/iam/sso/provider/from-metadata`,
      input,
      { showErrors: false },
    ),
  ).provider;
}

export async function deleteSsoProvider(accountId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(`/accounts/${accountId}/iam/sso/provider`),
  );
}

export async function listSsoGroupMappings(accountId: string) {
  return unwrap(
    await iamGet<{ mappings: SsoGroupMapping[] }>(
      `/accounts/${accountId}/iam/sso/mappings`,
    ),
  ).mappings;
}

export async function createSsoGroupMapping(
  accountId: string,
  input: { claim_value: string; group_id: string },
) {
  return unwrap(
    await backendApi.post<SsoGroupMapping>(`/accounts/${accountId}/iam/sso/mappings`, input, {
      showErrors: false,
    }),
  );
}

export async function deleteSsoGroupMapping(accountId: string, mappingId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/sso/mappings/${mappingId}`,
    ),
  );
}

// ─── Session controls ────────────────────────────────────────────────────

export interface SessionPolicy {
  /** Null = no max; positive integer = minutes. */
  max_lifetime_minutes: number | null;
  /** Null = no idle gate; positive integer = minutes. */
  idle_timeout_minutes: number | null;
}

export interface ActiveSession {
  user_id: string;
  session_id: string;
  first_seen_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

export async function getSessionPolicy(accountId: string) {
  return unwrap(await iamGet<SessionPolicy>(`/accounts/${accountId}/iam/session-policy`));
}

export async function updateSessionPolicy(accountId: string, patch: Partial<SessionPolicy>) {
  return unwrap(
    await backendApi.patch<SessionPolicy>(`/accounts/${accountId}/iam/session-policy`, patch, {
      showErrors: false,
    }),
  );
}

export async function listAccountSessions(accountId: string) {
  return unwrap(
    await iamGet<{ sessions: ActiveSession[] }>(`/accounts/${accountId}/iam/sessions`),
  ).sessions;
}

export async function revokeAccountSession(accountId: string, sessionId: string) {
  return unwrap(
    await backendApi.post<{ revoked: boolean }>(
      `/accounts/${accountId}/iam/sessions/${sessionId}/revoke`,
      {},
      { showErrors: false },
    ),
  );
}

// ─── PAT lifecycle policy ─────────────────────────────────────────────────

export interface PatPolicy {
  /** Null = no cap; positive integer = days from now. */
  max_lifetime_days: number | null;
  /** When true, minting without expires_at is refused. */
  require_expiry: boolean;
  /** Null = no idle revoke; positive integer = days. */
  idle_revoke_days: number | null;
}

export async function getPatPolicy(accountId: string) {
  return unwrap(await iamGet<PatPolicy>(`/accounts/${accountId}/iam/pat-policy`));
}

export async function updatePatPolicy(accountId: string, patch: Partial<PatPolicy>) {
  return unwrap(
    await backendApi.patch<PatPolicy>(`/accounts/${accountId}/iam/pat-policy`, patch, {
      showErrors: false,
    }),
  );
}

// ─── Service accounts (non-human IAM principals) ─────────────────────────

export interface ServiceAccount {
  service_account_id: string;
  name: string;
  description: string | null;
  public_prefix: string;
  status: 'active' | 'disabled';
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  disabled_at: string | null;
}

export interface CreatedServiceAccount extends ServiceAccount {
  /** Plaintext bearer — shown ONCE at create. Store it now or rotate. */
  secret: string;
}

export async function listServiceAccountsApi(accountId: string) {
  return unwrap(
    await iamGet<{ service_accounts: ServiceAccount[] }>(
      `/accounts/${accountId}/iam/service-accounts`,
    ),
  ).service_accounts;
}

export async function createServiceAccountApi(
  accountId: string,
  input: { name: string; description?: string; expires_at?: string },
) {
  return unwrap(
    await backendApi.post<CreatedServiceAccount>(
      `/accounts/${accountId}/iam/service-accounts`,
      input,
      { showErrors: false },
    ),
  );
}

export async function disableServiceAccountApi(accountId: string, saId: string) {
  return unwrap(
    await backendApi.post<{ disabled: boolean }>(
      `/accounts/${accountId}/iam/service-accounts/${saId}/disable`,
      {},
      { showErrors: false },
    ),
  );
}

export async function deleteServiceAccountApi(accountId: string, saId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/service-accounts/${saId}`,
    ),
  );
}

// ─── Audit webhooks ────────────────────────────────────────────────────────

export interface AuditWebhook {
  webhook_id: string;
  name: string;
  url: string;
  enabled: boolean;
  action_prefix: string | null;
  last_delivered_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatedAuditWebhook extends AuditWebhook {
  /** Plaintext HMAC signing secret — returned ONCE on create. Use it to
   *  verify the X-Kortix-Signature header in your receiver. */
  secret: string;
  /** Outcome of the one-shot test delivery fired at creation — lets the UI warn
   *  on an unreachable URL immediately instead of after silent audit-event loss. */
  test?: { ok: boolean; status?: number; error?: string };
}

export async function listAuditWebhooks(accountId: string) {
  return unwrap(
    await iamGet<{ webhooks: AuditWebhook[] }>(`/accounts/${accountId}/audit/webhooks`),
  ).webhooks;
}

export async function createAuditWebhook(
  accountId: string,
  input: { name: string; url: string; action_prefix?: string },
) {
  return unwrap(
    await backendApi.post<CreatedAuditWebhook>(`/accounts/${accountId}/audit/webhooks`, input, {
      showErrors: false,
    }),
  );
}

export async function updateAuditWebhook(
  accountId: string,
  webhookId: string,
  patch: { name?: string; enabled?: boolean; action_prefix?: string | null },
) {
  return unwrap(
    await backendApi.patch<AuditWebhook>(
      `/accounts/${accountId}/audit/webhooks/${webhookId}`,
      patch,
    ),
  );
}

export async function deleteAuditWebhook(accountId: string, webhookId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/audit/webhooks/${webhookId}`,
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
    await iamGet<{ events: AuditEvent[]; next_cursor: string | null }>(
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
    await iamGet<EffectivePermissionProbe>(
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

// ─── Enterprise demo toggle ───────────────────────────────────────────────
// Self-serve preview of the enterprise surface (SSO, SCIM, …). Backed by
// GET/PUT /accounts/:id/iam/enterprise-demo. Off by default; flipping it on
// unlocks the enterprise features for evaluation — NOT a real Enterprise plan.

export async function getEnterpriseDemo(accountId: string): Promise<boolean> {
  return unwrap(
    await iamGet<{ enabled: boolean }>(`/accounts/${accountId}/iam/enterprise-demo`),
  ).enabled;
}

export async function setEnterpriseDemo(accountId: string, enabled: boolean): Promise<boolean> {
  return unwrap(
    await backendApi.put<{ enabled: boolean }>(`/accounts/${accountId}/iam/enterprise-demo`, {
      enabled,
    }),
  ).enabled;
}
