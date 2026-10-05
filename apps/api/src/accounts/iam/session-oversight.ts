// IAM V2 routes: account session oversight.
//
// One account-level policy: when enabled, account owners and admins can open
// EVERY session in the account, including members' private ones. Off by
// default. Any member may READ it (the share dialog discloses it to them);
// only an account OWNER may change it — an admin must not be able to grant
// themselves read access to everyone's work. Every flip is audit-logged, and
// every read that only this policy allowed is audited by `loadVisibleSession`.

import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { accounts } from '@kortix/db';
import { json, errors, auth } from '../../openapi';
import { db } from '../../shared/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { actorOf } from '../../iam/actor';
import { accountRoleFor } from '../../iam/read-models';
import { invalidateSessionOversight } from '../../iam/session-oversight';
import { iamRouter, AccountIdParam } from './app';
import { auditIam } from './helpers';
import { readJsonObject } from '../../shared/http-body';

const SessionOversightStatus = z.object({
  enabled: z.boolean(),
  /** True when the caller is an account owner and may change the policy. */
  can_change: z.boolean(),
});

async function callerIsOwner(accountId: string, userId: string): Promise<boolean> {
  return (await accountRoleFor(accountId, userId)) === 'owner';
}

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/session-oversight',
    tags: ['iam'],
    summary: 'Get whether account owners and admins can open every session',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(SessionOversightStatus, 'Session oversight status'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_READ);

    const [row] = await db
      .select({ enabled: accounts.adminsSeeAllSessions })
      .from(accounts)
      .where(eq(accounts.accountId, accountId))
      .limit(1);
    if (!row) return c.json({ error: 'account not found' }, 404);
    return c.json({ enabled: row.enabled, can_change: await callerIsOwner(accountId, userId) });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/session-oversight',
    tags: ['iam'],
    summary: 'Enable or disable owner/admin access to every session (owner only)',
    ...auth,
    request: {
      params: AccountIdParam,
      body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } },
    },
    responses: {
      200: json(
        z.object({ enabled: z.boolean(), unchanged: z.boolean().optional() }),
        'Updated session oversight status',
      ),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const accountId = c.req.param('accountId');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
    if (!(await callerIsOwner(accountId, userId))) {
      return c.json(
        {
          error: 'Only an account owner can change who can open every session.',
          code: 'account_owner_required',
        },
        403,
      );
    }

    // `enabled` is REQUIRED: `{}` must never silently flip a privacy setting.
    const body = await readJsonObject(c);
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled (boolean) is required' }, 400);
    }
    const enabled = body.enabled;

    const [before] = await db
      .select({ enabled: accounts.adminsSeeAllSessions })
      .from(accounts)
      .where(eq(accounts.accountId, accountId))
      .limit(1);
    if (!before) return c.json({ error: 'account not found' }, 404);
    if (before.enabled === enabled) return c.json({ enabled, unchanged: true });

    await db
      .update(accounts)
      .set({ adminsSeeAllSessions: enabled, updatedAt: new Date() })
      .where(eq(accounts.accountId, accountId));
    invalidateSessionOversight();

    await auditIam(c, {
      accountId,
      action: enabled ? 'iam.session_oversight.enable' : 'iam.session_oversight.disable',
      resourceType: 'account',
      resourceId: accountId,
      before: { admins_see_all_sessions: before.enabled },
      after: { admins_see_all_sessions: enabled },
    });

    return c.json({ enabled });
  },
);
