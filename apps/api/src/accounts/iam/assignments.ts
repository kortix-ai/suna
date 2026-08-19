// The canonical assignment + permission-catalog REST surface.
//
// ONE grant table, ONE write path. `role_assignments` replaces
// `account_members.account_role`, `project_members.project_role`,
// `project_group_grants`, `iam_policies` and `iam_resource_grants`, so these
// three routes replace what were five differently-shaped APIs — each with its
// own principal vocabulary, its own scope encoding, and its own (or no)
// last-owner and delegability guards.
//
// The write routes deliberately assert NOTHING themselves. `assignRole` /
// `revokeAssignment` choose the required permission from WHAT is being granted
// (project.members.manage for a project role or an object grant, member.update
// for an account role, policy.create for a custom role), so the ceiling cannot
// be side-stepped by picking a different route — which is exactly what five
// parallel endpoints made possible.
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull, or } from 'drizzle-orm';
import { iamRoles } from '@kortix/db';
import { db } from '../../shared/db';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import {
  assignRole,
  listAssignments,
  revokeAssignment,
  type AssignmentRow,
  type PrincipalKind,
} from '../../iam/assignments';
import { loadPermissionCatalog, type ObjectType, type ScopeType } from '../../iam/catalog';
import { iamRouter, AccountIdParam } from './app';
import { readBody, requireEntitlement } from './helpers';

const PRINCIPAL_TYPES = ['user', 'group', 'service_account', 'pending'] as const;
const SCOPE_TYPES = ['account', 'project'] as const;
const OBJECT_TYPES = ['agent', 'skill', 'secret', 'app', 'trigger'] as const;

const AssignmentSchema = z
  .object({
    assignment_id: z.string(),
    account_id: z.string(),
    principal_type: z.string(),
    principal_id: z.string(),
    role_id: z.string(),
    role_key: z.string(),
    role_is_system: z.boolean(),
    scope_type: z.string(),
    scope_id: z.string().nullable(),
    object_type: z.string().nullable(),
    object_id: z.string().nullable(),
    expires_at: z.string().nullable(),
    granted_by: z.string().nullable(),
    source: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('IamAssignment');

const PermissionSchema = z
  .object({
    action: z.string(),
    scope_type: z.string(),
    resource_type: z.string(),
    delegable: z.boolean(),
    description: z.string(),
    area: z.string(),
    level: z.string(),
    implies: z.array(z.string()),
  })
  .openapi('IamPermission');

function serialize(row: AssignmentRow) {
  return {
    assignment_id: row.assignmentId,
    account_id: row.accountId,
    principal_type: row.principalType,
    principal_id: row.principalId,
    role_id: row.roleId,
    role_key: row.roleKey,
    role_is_system: row.roleIsSystem,
    scope_type: row.scopeType,
    scope_id: row.scopeId,
    object_type: row.objectType,
    object_id: row.objectId,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    granted_by: row.grantedBy,
    source: row.source,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function oneOf<T extends readonly string[]>(values: T, raw: unknown): T[number] | undefined {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw)
    ? (raw as T[number])
    : undefined;
}

// ─── GET /accounts/{accountId}/iam/assignments ──────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/assignments',
    tags: ['iam'],
    summary: 'List role assignments',
    ...auth,
    request: {
      params: AccountIdParam,
      query: z.object({
        principal_type: z.enum(PRINCIPAL_TYPES).optional(),
        principal_id: z.string().optional(),
        scope_type: z.enum(SCOPE_TYPES).optional(),
        scope_id: z.string().optional(),
        object_type: z.enum(OBJECT_TYPES).optional(),
        object_id: z.string().optional(),
        role_id: z.string().optional(),
        include_expired: z.enum(['true', 'false']).optional(),
      }),
    },
    responses: {
      200: json(z.object({ assignments: z.array(AssignmentSchema) }), 'Assignments'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.POLICY_READ);

    const principalType = oneOf(PRINCIPAL_TYPES, c.req.query('principal_type'));
    const principalId = c.req.query('principal_id');
    // A principal filter is one thing, not two: half of it silently widens the
    // answer to "every principal", which is the opposite of what the caller asked.
    if ((principalType && !principalId) || (!principalType && principalId)) {
      return c.json(
        { error: 'principal_type and principal_id must be supplied together' },
        400,
      );
    }

    const rows = await listAssignments({
      accountId,
      principal:
        principalType && principalId
          ? { type: principalType as PrincipalKind, id: principalId }
          : undefined,
      scopeType: oneOf(SCOPE_TYPES, c.req.query('scope_type')) as ScopeType | undefined,
      scopeId: c.req.query('scope_id') || undefined,
      objectType: oneOf(OBJECT_TYPES, c.req.query('object_type')) as ObjectType | undefined,
      objectId: c.req.query('object_id') || undefined,
      roleId: c.req.query('role_id') || undefined,
      liveOnly: c.req.query('include_expired') !== 'true',
    });
    return c.json({ assignments: rows.map(serialize) });
  },
);

// ─── POST /accounts/{accountId}/iam/assignments ─────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/assignments',
    tags: ['iam'],
    summary: 'Grant a role to a principal, at a scope, optionally on one object',
    ...auth,
    request: {
      params: AccountIdParam,
      body: { content: { 'application/json': { schema: z.record(z.string(), z.any()) } } },
    },
    responses: {
      201: json(AssignmentSchema, 'Created assignment'),
      ...errors(400, 401, 402, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const body = await readBody(c);

    const principalType = oneOf(PRINCIPAL_TYPES, body.principal_type ?? body.principalType);
    const principalId = body.principal_id ?? body.principalId;
    if (!principalType || typeof principalId !== 'string' || !principalId) {
      return c.json(
        { error: `principal_type (${PRINCIPAL_TYPES.join('|')}) and principal_id are required` },
        400,
      );
    }

    const scopeType = oneOf(SCOPE_TYPES, body.scope_type ?? body.scopeType);
    if (!scopeType) {
      return c.json({ error: `scope_type must be one of ${SCOPE_TYPES.join('|')}` }, 400);
    }
    const rawScopeId = body.scope_id ?? body.scopeId ?? null;
    if (rawScopeId != null && typeof rawScopeId !== 'string') {
      return c.json({ error: 'scope_id must be a project id string or null' }, 400);
    }
    const scopeId: string | null = rawScopeId;

    const roleId = body.role_id ?? body.roleId;
    const roleKey = body.role_key ?? body.roleKey ?? body.role;
    if (typeof roleId !== 'string' && typeof roleKey !== 'string') {
      return c.json({ error: 'role_id or role_key is required' }, 400);
    }

    const objectType = oneOf(OBJECT_TYPES, body.object_type ?? body.objectType);
    const objectId = body.object_id ?? body.objectId;
    if ((objectType && typeof objectId !== 'string') || (!objectType && objectId)) {
      return c.json({ error: 'object_type and object_id must be supplied together' }, 400);
    }

    let expiresAt: Date | null = null;
    const rawExpires = body.expires_at ?? body.expiresAt;
    if (rawExpires != null) {
      if (typeof rawExpires !== 'string') {
        return c.json({ error: 'expires_at must be an ISO-8601 string or null' }, 400);
      }
      const parsed = new Date(rawExpires);
      if (Number.isNaN(parsed.getTime())) {
        return c.json({ error: 'expires_at must be a valid ISO-8601 timestamp' }, 400);
      }
      if (parsed.getTime() < Date.now()) {
        return c.json({ error: 'expires_at must be in the future' }, 400);
      }
      expiresAt = parsed;
    }

    // Assigning a CUSTOM role is the `rbac` entitlement's surface, exactly as it
    // is on POST /iam/policies. Without this check the new endpoint would be a
    // way to buy nothing and still bind custom roles.
    if (typeof roleId === 'string') {
      const [role] = await db
        .select({ roleAccountId: iamRoles.accountId })
        .from(iamRoles)
        .where(
          and(eq(iamRoles.roleId, roleId), or(isNull(iamRoles.accountId), eq(iamRoles.accountId, accountId))),
        )
        .limit(1);
      if (!role) return c.json({ error: 'role not found in this account' }, 404);
      if (role.roleAccountId !== null) {
        const denied = await requireEntitlement(c, accountId, 'rbac');
        if (denied) return denied;
      }
    }

    // No assertAuthorized here on purpose — see the module note.
    const row = await assignRole(await actorOf(c, accountId), accountId, {
      principal: { type: principalType as PrincipalKind, id: principalId },
      ...(typeof roleId === 'string' ? { roleId } : { roleKey: roleKey as string }),
      scope: { type: scopeType as ScopeType, id: scopeId },
      ...(objectType && typeof objectId === 'string'
        ? { object: { type: objectType as ObjectType, id: objectId } }
        : {}),
      expiresAt,
      source: 'manual',
    });
    return c.json(serialize(row), 201);
  },
);

// ─── DELETE /accounts/{accountId}/iam/assignments/{assignmentId} ────────────

iamRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/iam/assignments/{assignmentId}',
    tags: ['iam'],
    summary: 'Revoke one assignment',
    ...auth,
    request: {
      params: z.object({ accountId: z.string(), assignmentId: z.string() }),
    },
    responses: {
      200: json(z.object({ revoked: z.boolean(), assignment: AssignmentSchema }), 'Revoked'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    const assignmentId = c.req.param('assignmentId');
    // The last-owner guard lives in revokeAssignment, not here — it is the only
    // place that sees every revoke path (route, SCIM deprovision, expiry).
    const row = await revokeAssignment(await actorOf(c, accountId), accountId, assignmentId);
    return c.json({ revoked: true, assignment: serialize(row) });
  },
);

// ─── GET /accounts/{accountId}/iam/permissions ──────────────────────────────
// The catalog, as DATA. `delegable` is the escalation ceiling
// (NON_DELEGABLE_ACTIONS as a column), `scope_type` is the ONE classifier the
// engine decides on, and `implies` is what the role-capability matrix used to
// hardcode client-side.

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/permissions',
    tags: ['iam'],
    summary: 'The permission catalog (action, scope, delegability, implications)',
    ...auth,
    request: {
      params: AccountIdParam,
      query: z.object({ scope_type: z.enum(SCOPE_TYPES).optional() }),
    },
    responses: {
      200: json(z.object({ permissions: z.array(PermissionSchema) }), 'Permission catalog'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ROLE_READ);
    const scopeType = oneOf(SCOPE_TYPES, c.req.query('scope_type'));
    const catalog = await loadPermissionCatalog();
    const rows = catalog.all
      .filter((p) => !scopeType || p.scopeType === scopeType)
      .sort((a, b) => a.action.localeCompare(b.action))
      .map((p) => ({
        action: p.action,
        scope_type: p.scopeType,
        resource_type: p.resourceType,
        delegable: p.delegable,
        description: p.description,
        area: p.area,
        level: p.level,
        implies: p.implies,
      }));
    return c.json({ permissions: rows });
  },
);
