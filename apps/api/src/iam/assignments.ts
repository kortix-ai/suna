/**
 * The ONE write path for authorization.
 *
 * Today there are 129 production write sites across 5 stores, each with its own
 * shape, its own (or no) authorization check, its own (or no) cache bust and its
 * own (or no) audit event — SCIM's 20 sites run under a bearer token with no
 * `assertAuthorized` anywhere, and `syncSsoMembership` mutates membership from
 * inside the auth middleware on every SAML request. Every one of them becomes a
 * call to `assignRole` / `revokeAssignment`.
 *
 * Each call: authorizes the WRITER, enforces the last-owner and delegability
 * ceilings, writes exactly ONE row, busts the caches that row invalidates, and
 * emits exactly ONE audit event.
 *
 * SCIM and SSO JIT keep bypassing user-authz by design — an IdP is not a user —
 * but they pass `source: 'scim' | 'sso'` and a system actor, so they no longer
 * bypass the store, the cache contract, or the audit trail.
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { accountGroups, accountMembers, iamRoleActions, iamRoles, roleAssignments, serviceAccounts } from '@kortix/db';
import { HTTPException } from 'hono/http-exception';
import { db } from '../shared/db';
import { recordAuditEvent } from '../shared/audit';
import { assertAuthorized, type Obj } from './authorize';
import { loadSystemRoles, loadPermissionCatalog, type ObjectType, type ScopeType } from './catalog';
import {
  invalidateIamCacheForGroup,
  invalidateIamCacheForUser,
  invalidateIamCacheForProjectResources,
} from './cache-invalidation';
import { pendingPrincipalId, type Actor, type PrincipalRef } from './actor';

export type AssignmentSource = 'manual' | 'scim' | 'sso' | 'invite' | 'system';

/** The principal vocabulary, as a nameable type for route-layer validation. */
export type PrincipalKind = PrincipalRef['type'];

export interface AssignmentScope {
  type: ScopeType;
  /** Required for `project`, forbidden for `account`. */
  id?: string | null;
}

export interface AssignRoleInput {
  principal: PrincipalRef;
  /** Either a role id (custom or system) or a system role key + scope. */
  roleId?: string;
  roleKey?: string;
  scope: AssignmentScope;
  /** Narrow the assignment to ONE object inside the scope. */
  object?: { type: ObjectType; id: string };
  expiresAt?: Date | null;
  source?: AssignmentSource;
}

export interface AssignmentRow {
  assignmentId: string;
  accountId: string;
  principalType: string;
  principalId: string;
  roleId: string;
  roleKey: string;
  roleIsSystem: boolean;
  scopeType: string;
  scopeId: string | null;
  objectType: string | null;
  objectId: string | null;
  expiresAt: Date | null;
  grantedBy: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A system actor for the two writers that legitimately have no user behind
 * them: SCIM (an IdP bearer token) and SSO JIT (the auth middleware). They skip
 * the writer-authorization step — `skipWriterAuthz` — and NOTHING else.
 */
export const SYSTEM_ACTOR = Symbol('kortix.iam.system-actor');
export type Writer = Actor | typeof SYSTEM_ACTOR;

// ─── Reads ──────────────────────────────────────────────────────────────────

export interface AssignmentFilter {
  accountId: string;
  principal?: PrincipalRef;
  principals?: PrincipalRef[];
  scopeType?: ScopeType;
  scopeId?: string;
  roleId?: string;
  objectType?: ObjectType;
  objectId?: string;
  /** Default true — expired rows are invisible, exactly as the engine sees them. */
  liveOnly?: boolean;
}

/** Every assignment matching the filter, newest first. */
export async function listAssignments(filter: AssignmentFilter): Promise<AssignmentRow[]> {
  const clauses = [eq(roleAssignments.accountId, filter.accountId)];
  if (filter.liveOnly !== false) {
    clauses.push(or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`))!);
  }
  const principals = filter.principals ?? (filter.principal ? [filter.principal] : []);
  if (principals.length === 1) {
    clauses.push(eq(roleAssignments.principalType, principals[0].type));
    clauses.push(eq(roleAssignments.principalId, principals[0].id));
  } else if (principals.length > 1) {
    clauses.push(
      or(
        ...principals.map((p) =>
          and(eq(roleAssignments.principalType, p.type), eq(roleAssignments.principalId, p.id)),
        ),
      )!,
    );
  }
  if (filter.scopeType) clauses.push(eq(roleAssignments.scopeType, filter.scopeType));
  if (filter.scopeId) clauses.push(eq(roleAssignments.scopeId, filter.scopeId));
  if (filter.roleId) clauses.push(eq(roleAssignments.roleId, filter.roleId));
  if (filter.objectType) clauses.push(eq(roleAssignments.objectType, filter.objectType));
  if (filter.objectId) clauses.push(eq(roleAssignments.objectId, filter.objectId));

  const rows = await db
    .select({
      assignmentId: roleAssignments.assignmentId,
      accountId: roleAssignments.accountId,
      principalType: roleAssignments.principalType,
      principalId: roleAssignments.principalId,
      roleId: roleAssignments.roleId,
      roleKey: iamRoles.key,
      roleAccountId: iamRoles.accountId,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
      objectType: roleAssignments.objectType,
      objectId: roleAssignments.objectId,
      expiresAt: roleAssignments.expiresAt,
      grantedBy: roleAssignments.grantedBy,
      source: roleAssignments.source,
      createdAt: roleAssignments.createdAt,
      updatedAt: roleAssignments.updatedAt,
    })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(and(...clauses))
    .orderBy(sql`${roleAssignments.createdAt} desc`);

  return rows.map(({ roleAccountId, ...r }) => ({ ...r, roleIsSystem: roleAccountId === null }));
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Grant a role. Idempotent on the assignment identity — re-granting the same
 * (principal, role, scope, object) updates `expires_at` and `source` rather
 * than creating a duplicate, which is the hole `iam_policies` has today (no
 * unique constraint at all, and `:bulk-import` happily creates duplicates).
 */
export async function assignRole(writer: Writer, accountId: string, input: AssignRoleInput): Promise<AssignmentRow> {
  const role = await resolveRole(accountId, input);
  const scopeType = input.scope.type;
  const scopeId = scopeType === 'project' ? (input.scope.id ?? null) : null;

  if (scopeType === 'project' && !scopeId) {
    throw new HTTPException(400, { message: 'a project-scoped assignment must name a project' });
  }
  if (scopeType === 'account' && input.scope.id) {
    throw new HTTPException(400, {
      message: 'an account-scoped assignment covers every project and must not name one',
    });
  }
  if (input.object && scopeType !== 'project') {
    throw new HTTPException(400, { message: 'an object assignment must be project-scoped' });
  }
  if (role.scopeType !== scopeType && !input.object) {
    throw new HTTPException(400, {
      message: `role "${role.key}" is a ${role.scopeType}-scoped role and cannot be assigned at ${scopeType} scope`,
    });
  }

  await assertPrincipalExists(accountId, input.principal);
  await assertWriterMayAssign(writer, accountId, role, scopeType, scopeId, input.object != null);
  await assertDelegable(role);

  // Raw SQL, not the query builder: the identity index is on EXPRESSIONS
  // (coalesced NULLs, because a plain unique index treats NULLs as distinct and
  // would let two byte-identical account-scope rows both exist), and drizzle's
  // `onConflictDoUpdate` target only accepts bare columns. Upserting rather
  // than inserting is what makes a re-grant idempotent instead of a duplicate —
  // the hole `iam_policies` has today with no unique constraint at all.
  const source = input.source ?? 'manual';
  const grantedBy = writerUserId(writer);
  // ISO string, not a Date: postgres.js binds template parameters positionally
  // and rejects a Date in a `::timestamptz` cast slot.
  const expiresAt = input.expiresAt ? input.expiresAt.toISOString() : null;
  const inserted = await db.execute(sql`
    insert into kortix.role_assignments
      (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
       object_type, object_id, expires_at, granted_by, source)
    values
      (${accountId}::uuid, ${input.principal.type}, ${input.principal.id}::uuid, ${role.roleId}::uuid,
       ${scopeType}, ${scopeId}::uuid, ${input.object?.type ?? null}, ${input.object?.id ?? null},
       ${expiresAt}::timestamptz, ${grantedBy}::uuid, ${source})
    on conflict (account_id, principal_type, principal_id, role_id, scope_type,
                 coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 coalesce(object_type, ''), coalesce(object_id, ''))
    do update set expires_at = excluded.expires_at,
                  source     = excluded.source,
                  granted_by = excluded.granted_by,
                  updated_at = now()
    returning assignment_id, account_id, principal_type, principal_id, role_id,
              scope_type, scope_id, object_type, object_id, expires_at,
              granted_by, source, created_at, updated_at
  `);
  const raw = (inserted as unknown as Record<string, unknown>[])[0];
  const row: AssignmentRow = {
    assignmentId: String(raw.assignment_id),
    accountId: String(raw.account_id),
    principalType: String(raw.principal_type),
    principalId: String(raw.principal_id),
    roleId: String(raw.role_id),
    roleKey: role.key,
    roleIsSystem: role.isSystem,
    scopeType: String(raw.scope_type),
    scopeId: (raw.scope_id as string | null) ?? null,
    objectType: (raw.object_type as string | null) ?? null,
    objectId: (raw.object_id as string | null) ?? null,
    expiresAt: raw.expires_at ? new Date(raw.expires_at as string) : null,
    grantedBy: (raw.granted_by as string | null) ?? null,
    source: String(raw.source),
    createdAt: new Date(raw.created_at as string),
    updatedAt: new Date(raw.updated_at as string),
  };

  await bustCachesFor(input.principal, scopeId);
  await audit(writer, accountId, 'iam.assignment.granted', row.assignmentId, null, describe(row, role.key));

  return row;
}

/**
 * Re-point an EXISTING assignment at a different role, scope or expiry, keeping
 * its id.
 *
 * The one caller is `PATCH /iam/policies/:policyId`, whose contract is that the
 * id survives the edit. A revoke-plus-grant would satisfy the model — the
 * identity of an assignment IS (principal, role, scope) — but it hands the
 * caller a new id for a row they are still holding a reference to, which is a
 * silent break for every client that PATCHes and then DELETEs.
 */
export async function updateAssignment(
  writer: Writer,
  accountId: string,
  assignmentId: string,
  input: { roleId: string; scope: AssignmentScope; expiresAt?: Date | null },
): Promise<AssignmentRow> {
  const [existing] = await listAssignmentsById(accountId, assignmentId);
  if (!existing) throw new HTTPException(404, { message: 'assignment not found' });

  const role = await resolveRole(accountId, { principal: { type: 'user', id: existing.principalId }, roleId: input.roleId, scope: input.scope });
  const scopeType = input.scope.type;
  const scopeId = scopeType === 'project' ? (input.scope.id ?? null) : null;
  if (scopeType === 'project' && !scopeId) {
    throw new HTTPException(400, { message: 'a project-scoped assignment must name a project' });
  }
  await assertWriterMayAssign(writer, accountId, role, scopeType, scopeId, false);
  await assertDelegable(role);

  const expiresAt = input.expiresAt ? input.expiresAt.toISOString() : null;
  let updated;
  try {
    updated = await db.execute(sql`
      update kortix.role_assignments
         set role_id = ${role.roleId}::uuid,
             scope_type = ${scopeType},
             scope_id = ${scopeId}::uuid,
             expires_at = ${expiresAt}::timestamptz,
             updated_at = now()
       where assignment_id = ${assignmentId}::uuid and account_id = ${accountId}::uuid
      returning assignment_id, created_at, updated_at, granted_by, source
    `);
  } catch (err) {
    // The identity index: this edit would collide with an assignment the
    // principal already holds. Revoke one of them instead of merging silently.
    if ((err as { code?: string })?.code === '23505') {
      throw new HTTPException(409, {
        message: 'this principal already holds that role at that scope',
      });
    }
    throw err;
  }
  const raw = (updated as unknown as Record<string, unknown>[])[0];
  if (!raw) throw new HTTPException(404, { message: 'assignment not found' });

  const row: AssignmentRow = {
    ...existing,
    roleId: role.roleId,
    roleKey: role.key,
    roleIsSystem: role.isSystem,
    scopeType,
    scopeId,
    expiresAt: input.expiresAt ?? null,
    updatedAt: new Date(raw.updated_at as string),
  };
  await bustCachesFor({ type: existing.principalType as PrincipalRef['type'], id: existing.principalId }, scopeId);
  await bustCachesFor({ type: existing.principalType as PrincipalRef['type'], id: existing.principalId }, existing.scopeId);
  await audit(writer, accountId, 'iam.assignment.granted', assignmentId, describe(existing, existing.roleKey), describe(row, role.key));
  return row;
}

/**
 * Revoke one assignment. The last-owner guard lives HERE, not in six route
 * handlers: an account must never reach zero live owners.
 */
export async function revokeAssignment(
  writer: Writer,
  accountId: string,
  assignmentId: string,
  /**
   * `skipWriterAuthz` is for a route that has ALREADY asserted its own, DIFFERENT
   * permission for this revoke — `policy.delete` on the legacy policies routes,
   * `project.members.manage` on the resource-grant route. Re-deriving the
   * grant-side action here would demand `policy.create` of a caller the route
   * deliberately let through on `policy.delete`. The writer is still carried so
   * the audit event names a person instead of the system.
   */
  opts: { skipWriterAuthz?: boolean } = {},
): Promise<AssignmentRow> {
  const [existing] = await listAssignmentsById(accountId, assignmentId);
  if (!existing) throw new HTTPException(404, { message: 'assignment not found' });

  const role = {
    roleId: existing.roleId,
    key: existing.roleKey,
    scopeType: existing.scopeType as ScopeType,
    isSystem: existing.roleIsSystem,
  };
  if (!opts.skipWriterAuthz) {
    await assertWriterMayAssign(
      writer,
      accountId,
      role,
      existing.scopeType as ScopeType,
      existing.scopeId,
      existing.objectType != null,
    );
  }
  await assertNotLastOwner(accountId, existing);
  await assertNotLastMembership(accountId, existing);

  // The canonical row AND the legacy row it mirrors, in ONE transaction.
  //
  // The dual-write triggers are one-way (legacy -> canonical) by design, so
  // deleting only the canonical row leaves the legacy row standing — and any
  // later UPDATE of it, from a pre-cutover replica or a support script, would
  // re-derive the assignment this call just revoked. A revoke that a rolling
  // deploy can silently undo is not a revoke.
  await db.transaction(async (tx) => {
    await deleteLegacyMirror(tx, accountId, existing);
    await tx.delete(roleAssignments).where(eq(roleAssignments.assignmentId, assignmentId));
  });

  await bustCachesFor(
    { type: existing.principalType as PrincipalRef['type'], id: existing.principalId },
    existing.scopeId,
  );
  await audit(writer, accountId, 'iam.assignment.revoked', assignmentId, describe(existing, existing.roleKey), null);

  return existing;
}

/**
 * Emit the revoke audit event for a row a caller deleted itself.
 *
 * The ONE legitimate use is a bulk offboarding that has ALREADY run its own
 * last-owner guard and must not run it again per row — SCIM deprovisioning,
 * which checks `isLastOwner` before it starts and would otherwise 409 on the
 * second-to-last owner's own removal. Everything else revokes through
 * `revokeAssignment`, which is where the guard lives.
 */
export async function auditAssignmentRevoked(
  writer: Writer,
  accountId: string,
  row: AssignmentRow,
): Promise<void> {
  await audit(writer, accountId, 'iam.assignment.revoked', row.assignmentId, describe(row, row.roleKey), null);
}

/**
 * Emit the audit event for an assignment that lapsed on its own. Called by the
 * expiry sweeper; the ROW is left in place, exactly as the current sweeper
 * leaves expired project_members rows, so the trail stays readable. Correctness
 * never depends on it — the engine filters `expires_at` in SQL.
 */
export async function auditAssignmentExpired(accountId: string, row: AssignmentRow): Promise<void> {
  await audit(SYSTEM_ACTOR, accountId, 'iam.assignment.expired', row.assignmentId, describe(row, row.roleKey), null);
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface ResolvedRole {
  roleId: string;
  key: string;
  scopeType: ScopeType;
  isSystem: boolean;
}

async function resolveRole(accountId: string, input: AssignRoleInput): Promise<ResolvedRole> {
  if (input.roleId) {
    const [row] = await db
      .select({
        roleId: iamRoles.roleId,
        key: iamRoles.key,
        scopeType: iamRoles.scopeType,
        roleAccountId: iamRoles.accountId,
      })
      .from(iamRoles)
      .where(
        and(
          eq(iamRoles.roleId, input.roleId),
          or(isNull(iamRoles.accountId), eq(iamRoles.accountId, accountId)),
        ),
      )
      .limit(1);
    if (!row) throw new HTTPException(404, { message: 'role not found in this account' });
    return {
      roleId: row.roleId,
      key: row.key,
      scopeType: row.scopeType as ScopeType,
      isSystem: row.roleAccountId === null,
    };
  }
  if (!input.roleKey) throw new HTTPException(400, { message: 'roleId or roleKey is required' });
  const system = await loadSystemRoles();
  const scopeForKey = input.object ? 'project' : input.scope.type;
  const key = canonicalRoleKey(scopeForKey, input.roleKey);
  const role = system.byKey.get(`${scopeForKey}:${key}`);
  if (!role) {
    const known = [...system.byKey.keys()]
      .filter((k) => k.startsWith(`${scopeForKey}:`))
      .map((k) => k.slice(scopeForKey.length + 1))
      .sort()
      .join(', ');
    throw new HTTPException(400, {
      message: `unknown system role "${scopeForKey}:${input.roleKey}" — known ${scopeForKey} roles: ${known}`,
    });
  }
  return { roleId: role.roleId, key: role.key, scopeType: role.scopeType, isSystem: true };
}

/**
 * Fold a historical project-role name onto the seeded key.
 *
 * `viewer` and `user` were folded into `member`, and `editor` into `manager`,
 * but the names are still on the wire: published SDKs send them, the roles list
 * carries `builtin:user` as the project floor role's id, and the enum column
 * still holds the old labels. Every other write path in this API already folds
 * them (`normalizeProjectRole`); the canonical write path has to as well, or the
 * key a client reads back from `GET /iam/roles` is rejected by
 * `POST /iam/assignments`.
 */
function canonicalRoleKey(scopeType: ScopeType, key: string): string {
  if (scopeType !== 'project') return key;
  if (key === 'user' || key === 'viewer') return 'member';
  if (key === 'editor') return 'manager';
  return key;
}

/**
 * The principal has to EXIST.
 *
 * Without this a fabricated uuid produces a row that grants nothing and shows
 * up on every access screen as an unresolvable id — and for a `service_account`
 * principal it is worse than cosmetic: an id that does not exist today can be
 * MINTED later (agent identities are auto-provisioned by name), so a grant
 * planted against a guessed id would come alive when the agent is first
 * launched. `pending` is the one kind with nothing to check — its id is
 * `uuid5(lower(email))`, derived rather than stored.
 */
async function assertPrincipalExists(accountId: string, principal: PrincipalRef): Promise<void> {
  if (principal.type === 'pending') return;

  if (principal.type === 'group') {
    const [row] = await db
      .select({ id: accountGroups.groupId })
      .from(accountGroups)
      .where(and(eq(accountGroups.groupId, principal.id), eq(accountGroups.accountId, accountId)))
      .limit(1);
    if (!row) throw new HTTPException(404, { message: 'principal_id is not a group in this account' });
    return;
  }

  if (principal.type === 'service_account') {
    const [row] = await db
      .select({ id: serviceAccounts.serviceAccountId })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.serviceAccountId, principal.id),
          eq(serviceAccounts.accountId, accountId),
          eq(serviceAccounts.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) {
      throw new HTTPException(404, {
        message: 'principal_id is not an active service account in this account',
      });
    }
    return;
  }

  // A user. Not "is a member of this account" — the FIRST account-scope
  // assignment is what makes them one, so that test would make membership
  // ungrantable. The auth user has to be real, which is the check that stops a
  // typo'd or fabricated id.
  const [row] = await db
    .select({ id: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, principal.id), eq(accountMembers.accountId, accountId)))
    .limit(1);
  if (row) return;
  const authRows = await db.execute<{ id: string }>(
    sql`select id::text from auth.users where id = ${principal.id}::uuid limit 1`,
  );
  const found = (authRows as unknown as { rows?: Array<{ id: string }> }).rows ?? authRows;
  if ((found as Array<{ id: string }>).length === 0) {
    throw new HTTPException(404, { message: 'principal_id is not a known user' });
  }
}

/**
 * May this writer hand out this role, here?
 *
 * The action is chosen by WHAT is being granted, so the ceiling cannot be
 * side-stepped by picking a different route:
 *   object assignment          -> project.members.manage on that project
 *   system role, project scope -> project.members.manage on that project
 *   system role, account scope -> member.update  (it re-parents who is admin)
 *   custom role, any scope     -> policy.create
 */
async function assertWriterMayAssign(
  writer: Writer,
  accountId: string,
  role: ResolvedRole,
  scopeType: ScopeType,
  scopeId: string | null,
  isObjectAssignment: boolean,
): Promise<void> {
  if (writer === SYSTEM_ACTOR) return;
  const projectObj: Obj = scopeId ? { type: 'project', id: scopeId } : { type: 'account' };
  if (isObjectAssignment || (role.isSystem && scopeType === 'project')) {
    await assertAuthorized(writer, 'project.members.manage', projectObj);
    return;
  }
  if (role.isSystem && scopeType === 'account') {
    await assertAuthorized(writer, 'member.update', { type: 'account' });
    return;
  }
  await assertAuthorized(writer, 'policy.create', { type: 'account' });
}

/**
 * The escalation ceiling, now a column instead of a hardcoded Set.
 *
 * `NON_DELEGABLE_ACTIONS` (17 actions) is the only thing stopping an account
 * admin — who already holds role.create + policy.create — from minting a role
 * carrying owner-only powers, binding themselves to it, and becoming an owner
 * in all but name. It used to be enforced only at role-CREATE time; enforcing
 * it again at ASSIGN time closes the case where the role predates the ceiling.
 * System roles are exempt: they ARE the ceiling.
 */
async function assertDelegable(role: ResolvedRole): Promise<void> {
  if (role.isSystem) return;
  const catalog = await loadPermissionCatalog();
  const rows = await db
    .select({ action: iamRoleActions.action })
    .from(iamRoleActions)
    .where(eq(iamRoleActions.roleId, role.roleId));
  const forbidden = rows
    .map((r) => r.action)
    .filter((a) => catalog.byAction.get(a)?.delegable === false);
  if (forbidden.length > 0) {
    throw new HTTPException(403, {
      message: `role "${role.key}" cannot be assigned: it carries non-delegable permission(s) ${forbidden.sort().join(', ')}`,
    });
  }
}

/**
 * An account must never reach zero live owners. The guard was six hand-written
 * `countOwners()` checks spread across members.ts, admin/index.ts and
 * scim/users.ts — one of which (SCIM `deprovisionMember`) is the only
 * membership-removal path with no `assertAuthorized` in front of it at all.
 */
async function assertNotLastOwner(accountId: string, row: AssignmentRow): Promise<void> {
  if (!row.roleIsSystem || row.roleKey !== 'owner' || row.scopeType !== 'account') return;
  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.scopeType, 'account'),
        isNull(iamRoles.accountId),
        eq(iamRoles.key, 'owner'),
        ne(roleAssignments.assignmentId, row.assignmentId),
        or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
      ),
    );
  if (remaining === 0) {
    throw new HTTPException(409, {
      message: 'this is the account’s last owner — promote another member to owner first',
    });
  }
}

/**
 * Removing a principal's LAST account-scope system role is offboarding, not a
 * role edit: it must also kill their PATs and live session tokens, release the
 * billing seat, and drop the `account_members` identity row. That whole
 * sequence lives on `DELETE /accounts/:accountId/members/:userId`.
 *
 * Doing it here would delete the assignment, leave the identity row behind, and
 * leave the removed member holding live tokens — a silent offboarding hole. So
 * this path refuses and names the one that does it completely.
 */
async function assertNotLastMembership(accountId: string, row: AssignmentRow): Promise<void> {
  if (!row.roleIsSystem || row.scopeType !== 'account' || row.principalType !== 'user') return;
  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.scopeType, 'account'),
        eq(roleAssignments.principalType, 'user'),
        eq(roleAssignments.principalId, row.principalId),
        isNull(iamRoles.accountId),
        ne(roleAssignments.assignmentId, row.assignmentId),
        or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
      ),
    );
  if (remaining === 0) {
    throw new HTTPException(409, {
      message:
        'this is the principal’s only account role — removing it removes their membership. Use DELETE /accounts/{accountId}/members/{userId}, which also revokes their tokens and releases the seat.',
    });
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The strongest SYSTEM project role this principal still holds on this project
 * once `row` is gone, or null when `row` was the last one.
 */
async function strongestRemainingProjectRole(
  tx: Tx,
  accountId: string,
  row: AssignmentRow,
): Promise<string | null> {
  const res = await tx.execute(sql`
    select r.key
      from kortix.role_assignments ra
      join kortix.iam_roles r on r.role_id = ra.role_id
     where ra.account_id = ${accountId}::uuid
       and ra.principal_type = ${row.principalType}
       and ra.principal_id = ${row.principalId}::uuid
       and ra.scope_type = 'project'
       and ra.scope_id = ${row.scopeId}::uuid
       and ra.object_type is null
       and ra.assignment_id <> ${row.assignmentId}::uuid
       and r.account_id is null
       and r.key <> 'agent-user'
       and (ra.expires_at is null or ra.expires_at > now())
     order by case r.key when 'manager' then 2 else 1 end desc
     limit 1
  `);
  const rows = (res as unknown as { rows?: Array<{ key: string }> }).rows ??
    (res as unknown as Array<{ key: string }>);
  return rows[0]?.key ?? null;
}

/**
 * Delete the LEGACY row this assignment is mirrored by, if any.
 *
 * One case per legacy store, and the account case is a re-point rather than a
 * delete: `account_members.account_role` cannot express "no role", and the row
 * itself is identity (is_super_admin, scim_external_id, joined_at) that a role
 * revoke must not destroy. `assertNotLastMembership` has already guaranteed at
 * least one other account-scope role survives, so there is always something to
 * re-point at.
 */
async function deleteLegacyMirror(tx: Tx, accountId: string, row: AssignmentRow): Promise<void> {
  const principal = row.principalType;

  if (row.objectType !== null) {
    await tx.execute(sql`
      delete from kortix.iam_resource_grants
       where account_id = ${accountId}::uuid
         and project_id = ${row.scopeId}::uuid
         and resource_type = ${row.objectType}
         and resource_id = ${row.objectId}
         and principal_type = ${principal === 'group' ? 'group' : 'member'}
         and principal_id = ${row.principalId}::uuid
    `);
    return;
  }

  if (!row.roleIsSystem) {
    const legacyPrincipal =
      principal === 'user' ? 'member' : principal === 'service_account' ? 'token' : principal;
    await tx.execute(sql`
      delete from kortix.iam_policies
       where account_id = ${accountId}::uuid
         and principal_type = ${legacyPrincipal}
         and principal_id = ${row.principalId}::uuid
         and role_id = ${row.roleId}::uuid
         and scope_type = ${row.scopeType}
         and scope_id is not distinct from ${row.scopeId}::uuid
    `);
    return;
  }

  if (row.scopeType === 'project' && (principal === 'group' || principal === 'user')) {
    // The legacy tables hold ONE row per (principal, project); the canonical
    // store lets a `member` and a `manager` assignment coexist. Deleting the
    // legacy row while another assignment survives would retract that one too,
    // through the very trigger this is keeping in step — so re-point when
    // something remains and delete only when nothing does.
    const remaining = await strongestRemainingProjectRole(tx, accountId, row);
    if (principal === 'group') {
      if (remaining) {
        await tx.execute(sql`
          update kortix.project_group_grants
             set role = ${remaining}::kortix.project_role
           where project_id = ${row.scopeId}::uuid and group_id = ${row.principalId}::uuid
        `);
      } else {
        await tx.execute(sql`
          delete from kortix.project_group_grants
           where project_id = ${row.scopeId}::uuid and group_id = ${row.principalId}::uuid
        `);
      }
      return;
    }
    if (remaining) {
      await tx.execute(sql`
        update kortix.project_members
           set project_role = ${remaining}::kortix.project_role
         where project_id = ${row.scopeId}::uuid and user_id = ${row.principalId}::uuid
      `);
    } else {
      await tx.execute(sql`
        delete from kortix.project_members
         where project_id = ${row.scopeId}::uuid and user_id = ${row.principalId}::uuid
      `);
    }
    return;
  }

  if (row.scopeType === 'account' && principal === 'user') {
    // Re-point at the strongest role that survives this revoke. The trigger on
    // this UPDATE then retracts any OTHER system account-scope assignment, so
    // the column and the store agree when the transaction commits.
    await tx.execute(sql`
      update kortix.account_members m
         set account_role = (
           select r.key
             from kortix.role_assignments ra
             join kortix.iam_roles r on r.role_id = ra.role_id
            where ra.account_id = ${accountId}::uuid
              and ra.principal_type = 'user'
              and ra.principal_id = ${row.principalId}::uuid
              and ra.scope_type = 'account'
              and ra.assignment_id <> ${row.assignmentId}::uuid
              and r.account_id is null
              and (ra.expires_at is null or ra.expires_at > now())
            order by case r.key when 'owner' then 3 when 'admin' then 2 else 1 end desc
            limit 1
         )::kortix.account_role
       where m.account_id = ${accountId}::uuid
         and m.user_id = ${row.principalId}::uuid
    `);
  }
}

/**
 * Drop every account-scope assignment a principal holds, without the guards.
 *
 * The ONE caller is membership removal (`DELETE /accounts/:id/members/:userId`
 * and `POST /accounts/:id/leave`), which has already run its own last-owner
 * check and already emitted the revoke audit events. The mirror trigger removes
 * these rows when the `account_members` row goes, but an assignment written
 * straight through `assignRole` has no legacy row behind it to fire on.
 */
export async function deleteAccountScopeAssignments(accountId: string, userId: string): Promise<void> {
  await db
    .delete(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.principalType, 'user'),
        eq(roleAssignments.principalId, userId),
        eq(roleAssignments.scopeType, 'account'),
      ),
    );
  invalidateIamCacheForUser(userId);
}

/** The project-scope sibling of `deleteAccountScopeAssignments`. */
export async function deleteProjectScopeAssignments(accountId: string, userId: string): Promise<void> {
  await db
    .delete(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.principalType, 'user'),
        eq(roleAssignments.principalId, userId),
        eq(roleAssignments.scopeType, 'project'),
      ),
    );
  invalidateIamCacheForUser(userId);
}

async function listAssignmentsById(accountId: string, assignmentId: string): Promise<AssignmentRow[]> {
  const rows = await listAssignments({ accountId, liveOnly: false });
  return rows.filter((r) => r.assignmentId === assignmentId);
}

/**
 * Assignments by id, across accounts. The ONE caller is the expiry sweeper,
 * which claims rows account-agnostically and needs the role key to describe
 * them in the audit event.
 */
export async function listAssignmentsByIds(assignmentIds: string[]): Promise<AssignmentRow[]> {
  if (assignmentIds.length === 0) return [];
  const rows = await db
    .select({
      assignmentId: roleAssignments.assignmentId,
      accountId: roleAssignments.accountId,
      principalType: roleAssignments.principalType,
      principalId: roleAssignments.principalId,
      roleId: roleAssignments.roleId,
      roleKey: iamRoles.key,
      roleAccountId: iamRoles.accountId,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
      objectType: roleAssignments.objectType,
      objectId: roleAssignments.objectId,
      expiresAt: roleAssignments.expiresAt,
      grantedBy: roleAssignments.grantedBy,
      source: roleAssignments.source,
      createdAt: roleAssignments.createdAt,
      updatedAt: roleAssignments.updatedAt,
    })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(inArray(roleAssignments.assignmentId, assignmentIds));
  return rows.map(({ roleAccountId, ...r }) => ({ ...r, roleIsSystem: roleAccountId === null }));
}

/**
 * One invalidation contract for one write path. A user principal busts its own
 * entries; a group principal fans out to its members, because each member's
 * effective role is derived from the group's assignments. An object assignment
 * additionally busts the project's object-grant memo, which is the one memo
 * that caches negatives.
 */
async function bustCachesFor(principal: PrincipalRef, scopeId: string | null): Promise<void> {
  if (principal.type === 'group') await invalidateIamCacheForGroup(principal.id);
  else invalidateIamCacheForUser(principal.id);
  if (scopeId) invalidateIamCacheForProjectResources(scopeId);
}

function writerUserId(writer: Writer): string | null {
  return writer === SYSTEM_ACTOR ? null : writer.userId;
}

function describe(row: Partial<AssignmentRow>, roleKey: string): Record<string, unknown> {
  return {
    assignment_id: row.assignmentId,
    principal_type: row.principalType,
    principal_id: row.principalId,
    role_id: row.roleId,
    role_key: roleKey,
    scope_type: row.scopeType,
    scope_id: row.scopeId ?? null,
    object_type: row.objectType ?? null,
    object_id: row.objectId ?? null,
    expires_at: row.expiresAt ?? null,
    source: row.source,
  };
}

async function audit(
  writer: Writer,
  accountId: string,
  action: 'iam.assignment.granted' | 'iam.assignment.revoked' | 'iam.assignment.expired',
  assignmentId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  try {
    await recordAuditEvent({
      accountId,
      actorUserId: writer === SYSTEM_ACTOR ? undefined : writer.userId,
      action,
      resourceType: 'role_assignment',
      resourceId: assignmentId,
      before,
      after,
      ip: writer === SYSTEM_ACTOR ? null : (writer.ctx.ip ?? null),
      userAgent: null,
    });
  } catch (err) {
    // An audit failure must never undo a mutation that already committed.
    console.error('[iam audit] failed to write assignment event', action, err);
  }
}

// ─── Pending (invitee) assignments ──────────────────────────────────────────

/**
 * A grant staged on an invitation, for an email with no Kortix user yet.
 *
 * `account_invitations.bootstrap_grants` is a jsonb blob nothing but the accept
 * path can read; as an assignment with `principal_type='pending'` the SAME
 * queries that answer "who has access to this project" see it, and the invite
 * is a first-class row in the one grant store instead of a side channel.
 *
 * The principal id is `uuid5(lower(email))`, so it is stable across invitations
 * and computable from the address alone — see `pendingPrincipalId`.
 */
export async function assignPendingProjectRole(
  accountId: string,
  email: string,
  input: { projectId: string; roleKey: string; expiresAt?: Date | null; grantedBy?: string | null },
): Promise<void> {
  await assignRole(SYSTEM_ACTOR, accountId, {
    principal: { type: 'pending', id: pendingPrincipalId(email) },
    roleKey: input.roleKey,
    scope: { type: 'project', id: input.projectId },
    expiresAt: input.expiresAt ?? null,
    source: 'invite',
  });
}

/** Drop staged grants for an email — the whole invitation, or one project. */
export async function revokePendingAssignments(
  accountId: string,
  email: string,
  projectId?: string,
): Promise<void> {
  const clauses = [
    eq(roleAssignments.accountId, accountId),
    eq(roleAssignments.principalType, 'pending'),
    eq(roleAssignments.principalId, pendingPrincipalId(email)),
  ];
  if (projectId) clauses.push(eq(roleAssignments.scopeId, projectId));
  await db.delete(roleAssignments).where(and(...clauses));
}

/**
 * Turn every staged grant for this email into a real one for this user.
 *
 * Called on EVERY accept, not only the first: acceptance is self-healing, and a
 * re-accept must re-assert grants a partial earlier run left behind.
 */
export async function convertPendingAssignments(
  accountId: string,
  email: string,
  userId: string,
): Promise<void> {
  const principalId = pendingPrincipalId(email);
  const staged = await listAssignments({
    accountId,
    principal: { type: 'pending', id: principalId },
    liveOnly: true,
  });
  for (const row of staged) {
    await assignRole(SYSTEM_ACTOR, accountId, {
      principal: { type: 'user', id: userId },
      roleId: row.roleId,
      scope: { type: row.scopeType as ScopeType, id: row.scopeId },
      ...(row.objectType && row.objectId
        ? { object: { type: row.objectType as ObjectType, id: row.objectId } }
        : {}),
      expiresAt: row.expiresAt,
      source: 'invite',
    });
  }
  await revokePendingAssignments(accountId, email);
}

/** Used by the expiry sweeper to find rows that lapsed since it last ran. */
export async function findExpiredAssignments(since: Date): Promise<AssignmentRow[]> {
  const rows = await db
    .select({
      assignmentId: roleAssignments.assignmentId,
      accountId: roleAssignments.accountId,
      principalType: roleAssignments.principalType,
      principalId: roleAssignments.principalId,
      roleId: roleAssignments.roleId,
      roleKey: iamRoles.key,
      roleAccountId: iamRoles.accountId,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
      objectType: roleAssignments.objectType,
      objectId: roleAssignments.objectId,
      expiresAt: roleAssignments.expiresAt,
      grantedBy: roleAssignments.grantedBy,
      source: roleAssignments.source,
      createdAt: roleAssignments.createdAt,
      updatedAt: roleAssignments.updatedAt,
    })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(
      and(
        sql`${roleAssignments.expiresAt} is not null`,
        sql`${roleAssignments.expiresAt} <= now()`,
        sql`${roleAssignments.expiresAt} > ${since}`,
      ),
    );
  return rows.map(({ roleAccountId, ...r }) => ({ ...r, roleIsSystem: roleAccountId === null }));
}

/** Bulk principal lookup used by the read models (`GET /projects/:id/access`). */
export async function assignmentsForPrincipals(
  accountId: string,
  principals: PrincipalRef[],
): Promise<AssignmentRow[]> {
  if (principals.length === 0) return [];
  return listAssignments({ accountId, principals });
}

/** Every assignment on one project, for the project access read model. */
export async function assignmentsForProject(accountId: string, projectId: string): Promise<AssignmentRow[]> {
  return listAssignments({ accountId, scopeType: 'project', scopeId: projectId });
}

/** Every group id an assignment names, so the caller can resolve their members. */
export function groupPrincipalIds(rows: AssignmentRow[]): string[] {
  return [...new Set(rows.filter((r) => r.principalType === 'group').map((r) => r.principalId))];
}

/** Narrow a filter to a set of role ids — used by the roles-usage read model. */
export async function assignmentsForRoles(accountId: string, roleIds: string[]): Promise<AssignmentRow[]> {
  if (roleIds.length === 0) return [];
  const rows = await db
    .select({
      assignmentId: roleAssignments.assignmentId,
      accountId: roleAssignments.accountId,
      principalType: roleAssignments.principalType,
      principalId: roleAssignments.principalId,
      roleId: roleAssignments.roleId,
      roleKey: iamRoles.key,
      roleAccountId: iamRoles.accountId,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
      objectType: roleAssignments.objectType,
      objectId: roleAssignments.objectId,
      expiresAt: roleAssignments.expiresAt,
      grantedBy: roleAssignments.grantedBy,
      source: roleAssignments.source,
      createdAt: roleAssignments.createdAt,
      updatedAt: roleAssignments.updatedAt,
    })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(and(eq(roleAssignments.accountId, accountId), inArray(roleAssignments.roleId, roleIds)));
  return rows.map(({ roleAccountId, ...r }) => ({ ...r, roleIsSystem: roleAccountId === null }));
}
