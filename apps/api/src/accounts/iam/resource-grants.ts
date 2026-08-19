// IAM V2 route: account-wide resource-grants rollup.
//
// Per-project resource grants (agent/skill scoping — see ../../iam/
// resource-grants.ts) are created and listed one project at a time via
// /v1/projects/:projectId/resource-grants. This route answers a different
// question: "across the WHOLE account, what has this member/group been
// granted, and in which projects?" — the account-wide access footprint used
// by the member/group detail page, same idea as
// /{accountId}/iam/members/{userId}/project-access but for resource-level
// grants instead of project roles.
//
// Single query: join iam_resource_grants -> projects (grants span every
// project in the account, so each row needs its project's id/name attached)
// filtered by account_id plus the optional principalType/principalId/
// projectId query filters. Uses idx_iam_resource_grants_account and
// idx_iam_resource_grants_principal — no new index, no N+1.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { and, eq, inArray } from 'drizzle-orm';
import { accountGroups, projects } from '@kortix/db';
import { objectGrantRows } from '../../iam/read-models';
import { db } from '../../shared/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import { isUuid, lookupEmailsByUserIds } from '../../projects/lib/access';
import { iamRouter, AccountIdParam } from './app';

const ResourceGrantRowSchema = z
  .object({
    grant_id: z.string(),
    project_id: z.string(),
    project_name: z.string(),
    resource_type: z.string(),
    resource_id: z.string(),
    principal_type: z.string(),
    principal_id: z.string(),
    principal_label: z.string(),
    granted_by: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string().nullable(),
  })
  .openapi('IamAccountResourceGrant');

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/resource-grants',
    tags: ['iam'],
    summary: 'List every resource grant across the account (optionally filtered)',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ grants: z.array(ResourceGrantRowSchema) }), 'Resource grants'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    // Read-only account-wide access-footprint view — same gate the member
    // detail page already uses for "which projects does this person reach"
    // (members.ts's /project-access route). No entitlement check: this
    // family only gates rbac on mutation routes (create/grow), never reads.
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_READ);

    // Legacy 'secret' rows are a back-compat holdover (see the resourceType
    // doc comment in ../../iam/resource-grants.ts) — new grants can't create
    // them and the account-wide view only surfaces the two live resource
    // kinds, same filter the per-project route applies.
    const principalType = c.req.query('principalType');
    const principalId = c.req.query('principalId');
    const projectId = c.req.query('projectId');

    // Object assignments from `role_assignments`, joined to their project the
    // way the old `iam_resource_grants -> projects` query did: a grant whose
    // project is gone is not part of the footprint.
    const [grants, projectRows] = await Promise.all([
      objectGrantRows({
        accountId,
        ...(projectId && isUuid(projectId) ? { projectId } : {}),
      }),
      db
        .select({ projectId: projects.projectId, name: projects.name })
        .from(projects)
        .where(eq(projects.accountId, accountId)),
    ]);
    const projectById = new Map(projectRows.map((p) => [p.projectId, p] as const));

    const rows = grants
      .filter((g) => {
        // Legacy 'secret' rows are a back-compat holdover (see the resourceType
        // doc comment in ../../iam/resource-grants.ts) — the account-wide view
        // surfaces only the two live resource kinds, same filter the
        // per-project route applies.
        if (g.resourceType === 'secret') return false;
        if (
          (principalType === 'member' || principalType === 'group') &&
          g.principalType !== principalType
        ) {
          return false;
        }
        if (principalId && isUuid(principalId) && g.principalId !== principalId) return false;
        return projectById.has(g.projectId);
      })
      .map((g) => ({
        grantId: g.grantId,
        projectId: g.projectId,
        projectName: projectById.get(g.projectId)!.name,
        resourceType: g.resourceType,
        resourceId: g.resourceId,
        principalType: g.principalType as string,
        principalId: g.principalId,
        grantedBy: g.grantedBy,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
      }));

    // Resolve principal labels in two batched lookups — same pattern as the
    // per-project route (projects/routes/resource-grants.ts): one
    // lookupEmailsByUserIds call for members, one accountGroups query for
    // groups. No per-row lookup.
    const memberIds = [
      ...new Set(rows.filter((r) => r.principalType === 'member').map((r) => r.principalId)),
    ];
    const groupIds = [
      ...new Set(rows.filter((r) => r.principalType === 'group').map((r) => r.principalId)),
    ];
    const emailByUser = memberIds.length
      ? await lookupEmailsByUserIds(memberIds)
      : new Map<string, string | null>();
    const groupNameById = new Map<string, string>();
    if (groupIds.length) {
      const groupRows = await db
        .select({ groupId: accountGroups.groupId, name: accountGroups.name })
        .from(accountGroups)
        .where(and(eq(accountGroups.accountId, accountId), inArray(accountGroups.groupId, groupIds)));
      for (const g of groupRows) groupNameById.set(g.groupId, g.name);
    }

    return c.json({
      grants: rows.map((r) => ({
        grant_id: r.grantId,
        project_id: r.projectId,
        project_name: r.projectName,
        resource_type: r.resourceType,
        resource_id: r.resourceId,
        principal_type: r.principalType,
        principal_id: r.principalId,
        principal_label:
          r.principalType === 'member'
            ? (emailByUser.get(r.principalId) ?? r.principalId)
            : (groupNameById.get(r.principalId) ?? r.principalId),
        granted_by: r.grantedBy,
        created_at: r.createdAt.toISOString(),
        expires_at: r.expiresAt?.toISOString() ?? null,
      })),
    });
  },
);
