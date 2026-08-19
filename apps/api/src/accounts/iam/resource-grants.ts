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
import { and, eq, inArray, ne } from 'drizzle-orm';
import { accountGroups, iamResourceGrants, projects } from '@kortix/db';
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
    const conds = [eq(iamResourceGrants.accountId, accountId), ne(iamResourceGrants.resourceType, 'secret')];

    const principalType = c.req.query('principalType');
    if (principalType === 'member' || principalType === 'group') {
      conds.push(eq(iamResourceGrants.principalType, principalType));
    }
    const principalId = c.req.query('principalId');
    if (principalId && isUuid(principalId)) {
      conds.push(eq(iamResourceGrants.principalId, principalId));
    }
    const projectId = c.req.query('projectId');
    if (projectId && isUuid(projectId)) {
      conds.push(eq(iamResourceGrants.projectId, projectId));
    }

    const rows = await db
      .select({
        grantId: iamResourceGrants.grantId,
        projectId: projects.projectId,
        projectName: projects.name,
        resourceType: iamResourceGrants.resourceType,
        resourceId: iamResourceGrants.resourceId,
        principalType: iamResourceGrants.principalType,
        principalId: iamResourceGrants.principalId,
        grantedBy: iamResourceGrants.grantedBy,
        createdAt: iamResourceGrants.createdAt,
        expiresAt: iamResourceGrants.expiresAt,
      })
      .from(iamResourceGrants)
      .innerJoin(projects, eq(projects.projectId, iamResourceGrants.projectId))
      .where(and(...conds));

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
