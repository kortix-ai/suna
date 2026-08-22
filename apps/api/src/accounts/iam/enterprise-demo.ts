// IAM V2 route: the **enterprise demo** state (read) + operator-only toggle.
//
// Enterprise features (SSO, SCIM, …) are normally gated behind the sales-
// assigned `enterprise` tier (see requireEntitlement + tiers.ts). The demo
// flag flips on an interactive PREVIEW of that surface for one account.
//
// The WRITE is platform-admin-only. It used to be self-serve (any account
// member with write), which made "enterprise demo" a free entitlement anyone
// could grant themselves; enabling it is now an operator decision, made in the
// admin console (POST /v1/admin/api/accounts/{id}/enterprise-demo — see
// admin/index.ts). This PUT stays for API-shape compatibility but enforces the
// same platform-admin role. The GET stays account-read so the account page can
// show the state. Fail-closed (default off); real production use still
// requires a signed Enterprise agreement.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import { isDemoEnterprise } from '../../billing/repositories/credit-accounts';
import { applyAdminOverride } from '../../billing/services/account-write-owner';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { iamRouter, AccountIdParam } from './app';
import { auditIam, readBody } from './helpers';

const DemoStateSchema = z.object({ enabled: z.boolean() }).openapi('EnterpriseDemoState');

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/enterprise-demo',
    tags: ['iam'],
    summary: 'Get the enterprise-demo toggle state',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(DemoStateSchema, 'Whether the enterprise demo is enabled'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_READ);
    return c.json({ enabled: await isDemoEnterprise(accountId) });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/iam/enterprise-demo',
    tags: ['iam'],
    summary: 'Enable or disable the enterprise demo for the account (platform admin only)',
    ...auth,
    request: {
      params: AccountIdParam,
      body: { content: { 'application/json': { schema: DemoStateSchema } } },
    },
    responses: {
      200: json(DemoStateSchema, 'The updated state'),
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    // Operator decision, not self-serve — platform admin role required. (No
    // account-membership check: admins are typically not members of the
    // account they are enabling the demo for.)
    if (!(await isPlatformAdmin(userId))) {
      return c.json({ error: 'Platform admin role required', code: 'admin_required' }, 403);
    }

    const body = await readBody(c);
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    const before = await isDemoEnterprise(accountId);
    await applyAdminOverride(
      accountId,
      { demoEnterprise: body.enabled },
      { userId, action: 'enterprise_demo.set' },
    );
    await auditIam(c, {
      accountId,
      action: body.enabled ? 'enterprise_demo.enable' : 'enterprise_demo.disable',
      resourceType: 'account',
      resourceId: accountId,
      before: { enabled: before },
      after: { enabled: body.enabled },
    });

    return c.json({ enabled: body.enabled });
  },
);
