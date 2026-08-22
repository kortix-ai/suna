// The canonical grant surface: ONE table, ONE write path.
//
// `role_assignments` replaced `account_members.account_role`,
// `project_members.project_role`, `project_group_grants`, `iam_policies` and
// `iam_resource_grants`. So this module replaces five differently-shaped client
// surfaces — each of which encoded the principal, the scope and the expiry its
// own way, and none of which could express "this role, on this project, on this
// one agent, until Friday" in a single row.
//
// A custom role is now ONE assignment. It is no longer "write a built-in
// baseline row, then write a policy row", a two-store sequence that only the
// browser enforced and that `Promise.allSettled` could leave half-applied.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** What a role can be bound to. `user` is an auth uid, `group` an `iam_groups`
 *  row, `service_account` the identity an agent runs as, `pending` an invitee
 *  who has not accepted yet (keyed by email). */
export type AssignmentPrincipalType = 'user' | 'group' | 'service_account' | 'pending';

/** A role binds at exactly one of two scopes. `account` covers every project in
 *  the account; `project` covers the one project named by `scope_id`. */
export type AssignmentScopeType = 'account' | 'project';

/** An assignment may narrow further to a single object inside its scope. */
export type AssignmentObjectType = 'agent' | 'skill' | 'secret' | 'app' | 'trigger';

/** Where the row came from. `manual` is a human write; `scim`/`sso` are
 *  directory sync; `invite` is a bootstrap grant; `system` is seeded. */
export type AssignmentSource = 'manual' | 'scim' | 'sso' | 'invite' | 'system';

/** A principal, addressed the same way everywhere. */
export interface PrincipalRef {
  type: AssignmentPrincipalType;
  id: string;
}

/** One row of `role_assignments`, as the API serializes it. */
export interface RoleAssignment {
  assignment_id: string;
  account_id: string;
  principal_type: AssignmentPrincipalType;
  principal_id: string;
  role_id: string;
  role_key: string;
  role_is_system: boolean;
  scope_type: AssignmentScopeType;
  scope_id: string | null;
  object_type: AssignmentObjectType | null;
  object_id: string | null;
  /** ISO-8601. `null` = permanent. Uniform across every assignment — built-in
   *  project grants used to have nowhere to store one. */
  expires_at: string | null;
  granted_by: string | null;
  source: AssignmentSource;
  created_at: string;
  updated_at: string;
}

/** What `createAssignment` needs. The role is named by id OR by key — key is
 *  the portable form for the seeded system roles (`owner`, `admin`, `member`,
 *  `manager`, `agent-user`), whose ids differ per deployment. */
export type AssignmentInput = {
  principal: PrincipalRef;
  scope: { type: 'account'; id?: null } | { type: 'project'; id: string };
  object?: { type: AssignmentObjectType; id: string };
  /** ISO-8601, or `null` for permanent. Omitted = permanent. */
  expiresAt?: string | null;
} & ({ roleId: string; roleKey?: never } | { roleKey: string; roleId?: never });

export interface ListAssignmentsFilter {
  /** Filter by principal. Both halves are required together — half a principal
   *  filter silently widens the answer to "every principal". */
  principalType?: AssignmentPrincipalType;
  principalId?: string;
  scopeType?: AssignmentScopeType;
  scopeId?: string;
  objectType?: AssignmentObjectType;
  objectId?: string;
  roleId?: string;
  /** Expired rows are filtered out by default. */
  includeExpired?: boolean;
}

/** One row of the permission catalog. This is the catalog as DATA — `area`,
 *  `level` and `implies` are what the role-capability matrix used to hardcode
 *  client-side, and `delegable` is the privilege-escalation ceiling. */
export interface Permission {
  action: string;
  scope_type: AssignmentScopeType;
  resource_type: string;
  delegable: boolean;
  description: string;
  /** Display grouping, e.g. `Secrets`, `Members`. Server-owned. */
  area: string;
  /** Rank inside the area, e.g. `view` / `edit`. Server-owned. */
  level: string;
  /** Actions this one entails. Seeded, engine-enforced — not a display rule. */
  implies: string[];
}

/**
 * IAM READS go through this, not `backendApi.get`: `showErrors: false` keeps a
 * capability-denied read (403 `policy.read`) out of the GLOBAL error toast. A
 * viewer who cannot read the roster should see the surface gated or hidden,
 * not a "contact support" toast. Mutations keep full error surfacing.
 */
function iamGet<T>(path: string) {
  return backendApi.get<T>(path, { showErrors: false });
}

function query(filter: ListAssignmentsFilter | undefined) {
  const params = new URLSearchParams();
  if (filter?.principalType) params.set('principal_type', filter.principalType);
  if (filter?.principalId) params.set('principal_id', filter.principalId);
  if (filter?.scopeType) params.set('scope_type', filter.scopeType);
  if (filter?.scopeId) params.set('scope_id', filter.scopeId);
  if (filter?.objectType) params.set('object_type', filter.objectType);
  if (filter?.objectId) params.set('object_id', filter.objectId);
  if (filter?.roleId) params.set('role_id', filter.roleId);
  if (filter?.includeExpired) params.set('include_expired', 'true');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Every assignment in the account, optionally narrowed. Live rows only unless
 *  `includeExpired` is set. */
export async function listAssignments(accountId: string, filter?: ListAssignmentsFilter) {
  return unwrap(
    await iamGet<{ assignments: RoleAssignment[] }>(
      `/accounts/${accountId}/iam/assignments${query(filter)}`,
    ),
  ).assignments;
}

/**
 * Grant one role, to one principal, at one scope — as ONE row.
 *
 * The route asserts nothing itself: the server picks the required permission
 * from WHAT is being granted (`project.members.manage` for a project role or an
 * object grant, `member.update` for an account role, `policy.create` for a
 * custom role), so the ceiling cannot be side-stepped by choosing a different
 * endpoint — which five parallel endpoints made possible.
 */
export async function createAssignment(accountId: string, input: AssignmentInput) {
  const body: Record<string, unknown> = {
    principal_type: input.principal.type,
    principal_id: input.principal.id,
    scope_type: input.scope.type,
    scope_id: input.scope.type === 'project' ? input.scope.id : null,
  };
  if (input.roleId) body.role_id = input.roleId;
  else body.role_key = input.roleKey;
  if (input.object) {
    body.object_type = input.object.type;
    body.object_id = input.object.id;
  }
  // Omitted means permanent; an explicit `null` says so on the wire. Both are
  // permanent — the distinction matters only to a PATCH-shaped caller.
  if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;

  return unwrap(await backendApi.post<RoleAssignment>(`/accounts/${accountId}/iam/assignments`, body));
}

/** Revoke one assignment. The last-owner guard lives server-side in
 *  `revokeAssignment()`, the only place that sees every revoke path. */
export async function revokeAssignment(accountId: string, assignmentId: string) {
  return unwrap(
    await backendApi.delete<{ revoked: boolean; assignment: RoleAssignment }>(
      `/accounts/${accountId}/iam/assignments/${assignmentId}`,
    ),
  ).assignment;
}

/** The permission catalog. Serve the areas, levels and implications from here
 *  instead of mirroring them in the client. */
export async function listPermissions(
  accountId: string,
  options?: { scopeType?: AssignmentScopeType },
) {
  const qs = options?.scopeType ? `?scope_type=${options.scopeType}` : '';
  return unwrap(
    await iamGet<{ permissions: Permission[] }>(`/accounts/${accountId}/iam/permissions${qs}`),
  ).permissions;
}
