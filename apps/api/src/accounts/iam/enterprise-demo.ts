// IAM V2 route: the self-serve **enterprise demo** toggle.
//
// Enterprise features (SSO, SCIM, …) are normally gated behind the sales-
// assigned `enterprise` tier (see requireEntitlement + tiers.ts). This toggle
// lets any account member flip on an interactive PREVIEW of that surface for
// their own account — no sales contact, no billing change — so prospects can
// feel the enterprise features and we can dogfood them in development.
//
// Deliberately NOT behind requireEntitlement: unlocking the demo is the whole
// point. It is fail-closed (default off) and clearly labelled a demo in the UI;
// real production use still requires a signed Enterprise agreement.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { isDemoEnterprise, setDemoEnterprise } from '../../billing/repositories/credit-accounts';
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
    return c.json({ enabled: await isDemoEnterprise(accountId) });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'put',
    path: '/{accountId}/iam/enterprise-demo',
    tags: ['iam'],
    summary: 'Enable or disable the enterprise demo for the account',
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
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

    const body = await readBody(c);
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    const before = await isDemoEnterprise(accountId);
    await setDemoEnterprise(accountId, body.enabled);
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
