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
import { iamRoleActions, iamRoles, roleAssignments } from '@kortix/db';
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
import type { Actor, PrincipalRef } from './actor';

export type AssignmentSource = 'manual' | 'scim' | 'sso' | 'invite' | 'system';

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
 * Revoke one assignment. The last-owner guard lives HERE, not in six route
 * handlers: an account must never reach zero live owners.
 */
export async function revokeAssignment(writer: Writer, accountId: string, assignmentId: string): Promise<AssignmentRow> {
  const [existing] = await listAssignmentsById(accountId, assignmentId);
  if (!existing) throw new HTTPException(404, { message: 'assignment not found' });

  const role = {
    roleId: existing.roleId,
    key: existing.roleKey,
    scopeType: existing.scopeType as ScopeType,
    isSystem: existing.roleIsSystem,
  };
  await assertWriterMayAssign(
    writer,
    accountId,
    role,
    existing.scopeType as ScopeType,
    existing.scopeId,
    existing.objectType != null,
  );
  await assertNotLastOwner(accountId, existing);

  await db.delete(roleAssignments).where(eq(roleAssignments.assignmentId, assignmentId));

  await bustCachesFor(
    { type: existing.principalType as PrincipalRef['type'], id: existing.principalId },
    existing.scopeId,
  );
  await audit(writer, accountId, 'iam.assignment.revoked', assignmentId, describe(existing, existing.roleKey), null);

  return existing;
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
  const role = system.byKey.get(`${scopeForKey}:${input.roleKey}`);
  if (!role) {
    throw new HTTPException(400, { message: `unknown system role "${scopeForKey}:${input.roleKey}"` });
  }
  return { roleId: role.roleId, key: role.key, scopeType: role.scopeType, isSystem: true };
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

async function listAssignmentsById(accountId: string, assignmentId: string): Promise<AssignmentRow[]> {
  const rows = await listAssignments({ accountId, liveOnly: false });
  return rows.filter((r) => r.assignmentId === assignmentId);
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
