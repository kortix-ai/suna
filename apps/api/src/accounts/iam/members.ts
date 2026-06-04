// IAM V2 routes: super-admin promotion + per-member views (group
// memberships, effective project access, single + batch permission probes).

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { and, eq, inArray } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  projectGroupGrants,
  projectMembers,
  projects,
} from '@kortix/db';
import { db } from '../../shared/db';
import {
  ACCOUNT_ACTIONS,
  assertAuthorized,
  authorize,
  resourceTypeForAction,
} from '../../iam';
import { listGroupsForMember } from '../../repositories/iam';
import {
  iamRouter,
  MemberParams,
  GroupSchema,
  ProjectAccessSchema,
  EffectiveResultSchema,
  EffectiveBatchResultSchema,
  isResourceType,
} from './app';
import { auditIam, readBody } from './helpers';

// ─── Super-admin promotion ─────────────────────────────────────────────────

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/members/{userId}/super-admin',
    tags: ['iam'],
    summary: 'Grant or revoke super-admin',
    ...auth,
    request: { params: MemberParams, body: { content: { 'application/json': { schema: z.object({ isSuperAdmin: z.boolean(), is_super_admin: z.boolean() }).partial() } } } },
    responses: {
      200: json(z.object({ user_id: z.string(), is_super_admin: z.boolean() }), 'Updated super-admin flag'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');
  await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT);

  const body = await readBody(c);
  // Accept camelCase or snake_case, but the field MUST be present and an
  // actual boolean. The previous `=== true` coercion meant a PATCH that
  // omitted the field (or sent a non-boolean) silently set
  // is_super_admin=false — i.e. a malformed/partial request could quietly
  // REVOKE super-admin. Reject those with a 400 instead of acting on them.
  const isSuperAdmin =
    typeof body.isSuperAdmin === 'boolean'
      ? body.isSuperAdmin
      : typeof body.is_super_admin === 'boolean'
        ? body.is_super_admin
        : undefined;
  if (isSuperAdmin === undefined) {
    return c.json({ error: 'isSuperAdmin (boolean) is required' }, 400);
  }

  // The V1 two-person approval gate (requireApproval / NeedsApprovalError)
  // was removed with the approvals workflow in PR5c. Super-admin grants
  // now apply immediately, gated only by the caller's own
  // member.super_admin.grant permission asserted above.

  // Snapshot the prior flag so an audit reader can see "Alice already had
  // super-admin → no-op" vs "Alice was promoted on March 5". Cheap query
  // since the row is small and the update runs against the same key.
  const [before] = await db
    .select({ isSuperAdmin: accountMembers.isSuperAdmin })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)),
    )
    .limit(1);

  const [updated] = await db
    .update(accountMembers)
    .set({ isSuperAdmin })
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.userId, targetUserId),
      ),
    )
    .returning({ userId: accountMembers.userId, isSuperAdmin: accountMembers.isSuperAdmin });

  if (!updated) return c.json({ error: 'member not found' }, 404);

  await auditIam(c, {
    accountId,
    action: updated.isSuperAdmin
      ? 'iam.member.super_admin.grant'
      : 'iam.member.super_admin.revoke',
    resourceType: 'account_member',
    resourceId: targetUserId,
    before: { is_super_admin: before?.isSuperAdmin ?? false },
    after: { is_super_admin: updated.isSuperAdmin },
  });

  return c.json({
    user_id: updated.userId,
    is_super_admin: updated.isSuperAdmin,
  });
  },
);

// ─── Member's group memberships ────────────────────────────────────────────
// Used by the member detail page so admins can see "this person inherits
// these policies via these groups".

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/members/{userId}/groups',
    tags: ['iam'],
    summary: 'List group memberships for a member',
    ...auth,
    request: { params: MemberParams },
    responses: {
      200: json(z.object({ groups: z.array(GroupSchema) }), 'Groups the member belongs to'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  // Users can always see their own group memberships; otherwise gate on
  // member.read (same rule as the effective-permission probe).
  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const rows = await listGroupsForMember(accountId, targetUserId);
  return c.json({
    groups: rows.map((r) => ({
      group_id: r.groupId,
      name: r.name,
      added_at: r.addedAt.toISOString(),
    })),
  });
  },
);

// V2-only: which projects does this member reach, and at what role?
// Combines three sources, max-role per project:
//   1. account_members.account_role of 'owner' or 'admin' → implicit
//      Manager on every active project in the account
//   2. direct project_members.project_role rows
//   3. project_group_grants for any group the user belongs to
// V1 callers can use the route too — the data is real either way — but
// the V1 UI doesn't surface it (PoliciesTable is the equivalent V1 view).
iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/members/{userId}/project-access',
    tags: ['iam'],
    summary: 'List effective project access for a member',
    ...auth,
    request: { params: MemberParams },
    responses: {
      200: json(z.object({ projects: z.array(ProjectAccessSchema) }), 'Projects the member can reach'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  type Role = 'manager' | 'editor' | 'viewer';
  const rank: Record<Role, number> = { viewer: 1, editor: 2, manager: 3 };
  const max = (a: Role, b: Role): Role => (rank[a] >= rank[b] ? a : b);

  // Project info we'll need for every row in the response.
  const allProjects = await db
    .select({
      projectId: projects.projectId,
      name: projects.name,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.accountId, accountId));
  const projectMeta = new Map(allProjects.map((p) => [p.projectId, p] as const));

  // 1) implicit manager via account_role
  const [membership] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!membership) {
    return c.json({ projects: [] });
  }

  const byProject = new Map<
    string,
    { role: Role; sources: ('implicit' | 'direct' | 'group')[] }
  >();
  if (membership.accountRole === 'owner' || membership.accountRole === 'admin') {
    for (const p of allProjects) {
      if (p.status !== 'active') continue;
      byProject.set(p.projectId, { role: 'manager', sources: ['implicit'] });
    }
  }

  // 2) direct project_members rows
  const directRows = await db
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.projectRole,
    })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.accountId, accountId),
        eq(projectMembers.userId, targetUserId),
      ),
    );
  for (const r of directRows) {
    const role = r.role as Role;
    const cur = byProject.get(r.projectId);
    if (cur) {
      cur.role = max(cur.role, role);
      if (!cur.sources.includes('direct')) cur.sources.push('direct');
    } else {
      byProject.set(r.projectId, { role, sources: ['direct'] });
    }
  }

  // 3) group grants for any group this user belongs to
  const groupMembershipRows = await db
    .select({ groupId: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, targetUserId));
  const groupIds = groupMembershipRows.map((g) => g.groupId);
  if (groupIds.length > 0) {
    const grantRows = await db
      .select({
        projectId: projectGroupGrants.projectId,
        role: projectGroupGrants.role,
      })
      .from(projectGroupGrants)
      .where(
        and(
          eq(projectGroupGrants.accountId, accountId),
          inArray(projectGroupGrants.groupId, groupIds),
        ),
      );
    for (const r of grantRows) {
      const role = r.role as Role;
      const cur = byProject.get(r.projectId);
      if (cur) {
        cur.role = max(cur.role, role);
        if (!cur.sources.includes('group')) cur.sources.push('group');
      } else {
        byProject.set(r.projectId, { role, sources: ['group'] });
      }
    }
  }

  const out: Array<{
    project_id: string;
    project_name: string;
    role: Role;
    sources: ('implicit' | 'direct' | 'group')[];
  }> = [];
  for (const [projectId, info] of byProject) {
    const meta = projectMeta.get(projectId);
    if (!meta || meta.status !== 'active') continue;
    out.push({
      project_id: projectId,
      project_name: meta.name,
      role: info.role,
      sources: info.sources,
    });
  }
  out.sort((a, b) => a.project_name.localeCompare(b.project_name));
  return c.json({ projects: out });
  },
);

// ─── Effective permissions probe ───────────────────────────────────────────
// The UI uses this to render "what can this user actually do".

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/members/{userId}/effective',
    tags: ['iam'],
    summary: 'Probe effective permission for a member',
    ...auth,
    request: { params: MemberParams, query: z.object({ action: z.string(), resourceType: z.string(), resourceId: z.string() }).partial() },
    responses: {
      200: json(EffectiveResultSchema, 'Effective-permission result'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  // Anyone with member.read can probe anyone; users can always probe themselves.
  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const action = c.req.query('action');
  if (!action) {
    return c.json({ error: 'action query parameter is required' }, 400);
  }

  const scope = c.req.query('resourceType');
  const id = c.req.query('resourceId');

  let target: Parameters<typeof authorize>[3];
  if (scope && isResourceType(scope) && scope !== 'account') {
    if (!id) return c.json({ error: 'resourceId required when resourceType is specified' }, 400);
    target = { type: scope, id } as Parameters<typeof authorize>[3];
  } else {
    target = { type: 'account' };
  }

  const result = await authorize(targetUserId, accountId, action, target);
  return c.json({
    allowed: result.allowed,
    reason: result.reason ?? null,
    action,
    resource_type: resourceTypeForAction(action),
  });
  },
);

// Batch variant. UIs that render N capability rows (the "what this member
// can do" panel, multi-button gating on a single screen) should call this
// instead of N separate /effective?action=... requests. Returns answers in
// the same order as the input; duplicates are NOT de-duped server-side so
// the caller can rely on indices matching.
const BATCH_MAX = 64;

iamRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/iam/members/{userId}/effective:batch',
    tags: ['iam'],
    summary: 'Batch-probe effective permissions for a member',
    ...auth,
    request: { params: MemberParams, body: { content: { 'application/json': { schema: z.object({ probes: z.array(z.record(z.string(), z.any())).optional(), queries: z.array(z.record(z.string(), z.any())).optional() }) } } } },
    responses: {
      200: json(z.object({ results: z.array(EffectiveBatchResultSchema) }), 'Batch effective-permission results'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
  const callerId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  if (callerId !== targetUserId) {
    await assertAuthorized(callerId, accountId, ACCOUNT_ACTIONS.MEMBER_READ);
  }

  const body = await readBody(c);
  const rawProbes = body.probes ?? body.queries;
  if (!Array.isArray(rawProbes)) {
    return c.json({ error: 'probes must be an array' }, 400);
  }
  if (rawProbes.length === 0) {
    return c.json({ results: [] });
  }
  if (rawProbes.length > BATCH_MAX) {
    return c.json(
      { error: `batch size must be ≤ ${BATCH_MAX} (got ${rawProbes.length})` },
      400,
    );
  }

  // Validate each probe BEFORE dispatching anything. Mixing valid and
  // invalid in the same batch is rejected entirely so the caller doesn't
  // get partial results that look successful at first glance.
  type ParsedProbe = {
    action: string;
    target: Parameters<typeof authorize>[3];
  };
  const parsed: ParsedProbe[] = [];
  for (let i = 0; i < rawProbes.length; i++) {
    const p = rawProbes[i];
    if (!p || typeof p !== 'object') {
      return c.json({ error: `probes[${i}] must be an object` }, 400);
    }
    const action = (p as { action?: unknown }).action;
    if (typeof action !== 'string' || !action) {
      return c.json({ error: `probes[${i}].action is required` }, 400);
    }
    const scope =
      (p as { resourceType?: unknown; resource_type?: unknown }).resourceType ??
      (p as { resource_type?: unknown }).resource_type;
    const id =
      (p as { resourceId?: unknown; resource_id?: unknown }).resourceId ??
      (p as { resource_id?: unknown }).resource_id;
    let target: Parameters<typeof authorize>[3];
    if (typeof scope === 'string' && isResourceType(scope) && scope !== 'account') {
      if (typeof id !== 'string' || !id) {
        return c.json(
          { error: `probes[${i}].resourceId required when resourceType is set` },
          400,
        );
      }
      target = { type: scope, id } as Parameters<typeof authorize>[3];
    } else if (scope !== undefined && scope !== 'account' && typeof scope === 'string') {
      // Caller passed something for resourceType but it's not a valid enum.
      return c.json(
        { error: `probes[${i}].resourceType is not a known resource type` },
        400,
      );
    } else {
      target = { type: 'account' };
    }
    parsed.push({ action, target });
  }

  // Dedupe in-flight calls but preserve output positions. This makes
  // duplicate (action,target) entries in the input free after the first.
  const cache = new Map<string, ReturnType<typeof authorize>>();
  const keyFor = (p: ParsedProbe) =>
    p.target?.type === 'account'
      ? `${p.action}|account|*`
      : `${p.action}|${p.target?.type}|${
          p.target && 'id' in p.target ? p.target.id : '*'
        }`;

  const results = await Promise.all(
    parsed.map(async (p) => {
      const key = keyFor(p);
      let inflight = cache.get(key);
      if (!inflight) {
        inflight = authorize(targetUserId, accountId, p.action, p.target);
        cache.set(key, inflight);
      }
      const r = await inflight;
      return {
        action: p.action,
        resource_type: resourceTypeForAction(p.action),
        resource_id: p.target && 'id' in p.target ? p.target.id : null,
        allowed: r.allowed,
        reason: r.reason ?? null,
      };
    }),
  );

  return c.json({ results });
  },
);
