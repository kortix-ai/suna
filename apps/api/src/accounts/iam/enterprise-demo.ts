// IAM route: the Enterprise DEMO — a self-serve switch for the Enterprise
// features (.agents/skills/billing/references/plans-and-access.md, "Enterprise").
//
// An owner or admin (`billing.write`) turns it on or off; turning it on emails
// Kortix sales. A platform admin may switch it for any account. The account is
// marked "Demo" wherever Enterprise shows; a license contract (Licensed) is the
// paid state. Demo keeps the plan's limits and the BYOK fee.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import { getCreditAccount } from '../../billing/repositories/credit-accounts';
import { applyAdminOverride } from '../../billing/services/account-write-owner';
import { invalidateAccountBilling } from '../../billing/services/billing-cache';
import { notifySales } from '../../billing/services/enterprise-sales';
import { enterpriseStateOf } from '../../billing/services/resolve-billing';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { iamRouter, AccountIdParam } from './app';
import { auditIam } from './http-helpers';

const DemoState = z
  .object({
    enabled: z.boolean(),
    state: z.enum(['off', 'demo', 'licensed']),
  })
  .openapi('EnterpriseDemoState');

async function stateOf(accountId: string) {
  const row = await getCreditAccount(accountId);
  return { enabled: row?.demoEnterprise === true, state: enterpriseStateOf(row) };
}

export function registerIamEnterpriseDemoRoutes(): void {
  iamRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/iam/enterprise-demo',
      tags: ['iam'],
      summary: 'Get the Enterprise demo and Enterprise state',
      ...auth,
      request: { params: AccountIdParam },
      responses: {
        200: json(DemoState, 'Whether the demo is on, and the Enterprise state'),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const { accountId } = c.req.valid('param');
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_READ);
      return c.json(await stateOf(accountId), 200);
    },
  );

  iamRouter.openapi(
    createRoute({
      method: 'put',
      path: '/{accountId}/iam/enterprise-demo',
      tags: ['iam'],
      summary: 'Turn the Enterprise demo on or off (owners and admins)',
      ...auth,
      request: {
        params: AccountIdParam,
        body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } },
      },
      responses: {
        200: json(DemoState, 'The updated state'),
        ...errors(400, 401, 403),
      },
    }),
    async (c) => {
      const { accountId } = c.req.valid('param');
      const { enabled } = c.req.valid('json');
      const userId = c.get('userId') as string;
      // A platform admin switches any account (support, or withdrawing a
      // demo); everyone else needs billing.write on this account.
      if (!(await isPlatformAdmin(userId))) {
        await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.BILLING_WRITE);
      }

      const before = await stateOf(accountId);
      if (before.enabled !== enabled) {
        await applyAdminOverride(
          accountId,
          { demoEnterprise: enabled },
          { userId, action: enabled ? 'enterprise_demo.enable' : 'enterprise_demo.disable' },
        );
        invalidateAccountBilling(accountId);
        await auditIam(c, {
          accountId,
          action: enabled ? 'enterprise_demo.enable' : 'enterprise_demo.disable',
          resourceType: 'account',
          resourceId: accountId,
          before: { enabled: before.enabled },
          after: { enabled },
        });
      }
      const after = await stateOf(accountId);
      if (enabled && !before.enabled) {
        await notifySales({
          accountId,
          signal: 'demo_on',
          userEmail: (c.get('userEmail') as string | undefined) ?? null,
          enterprise: after.state,
        });
      }
      return c.json(after, 200);
    },
  );
}
