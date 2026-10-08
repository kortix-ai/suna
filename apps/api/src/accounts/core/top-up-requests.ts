import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { requestTopUp } from '../../billing/services/top-up-requests';
import { ACCOUNT_ACTIONS } from '../../iam/actions';
import { actorOf } from '../../iam/actor';
import { authorize } from '../../iam/authorize';
import { AccountIdParam, accountsRouter, getMembership } from './app';

/**
 * POST /v1/accounts/:accountId/top-up-requests — a member out of credits asks
 * the owners to add some (KRTX-1718). On the accounts router, not the billing
 * app: the member reaches it from the out-of-credits notice in a session.
 */
export function registerTopUpRequestRoutes(): void {
  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/top-up-requests',
      tags: ['accounts'],
      summary: 'Ask the account owners to add credits',
      description:
        'Emails every owner of the account that the caller needs credits. Once per member and account in 24 hours. ' +
        'A caller who can add credits (billing.write) gets 409 can_manage_billing.',
      ...auth,
      request: { params: AccountIdParam },
      responses: {
        202: json(z.object({ notified: z.number().int() }), 'The owners were emailed'),
        ...errors(401, 403, 409, 429),
      },
    }),
    async (c) => {
      const { accountId } = c.req.valid('param');
      const userId = c.get('userId') as string;
      if (!(await getMembership(userId, accountId))) return c.json({ error: 'Forbidden' }, 403);
      if ((await authorize(await actorOf(c, accountId), ACCOUNT_ACTIONS.BILLING_WRITE)).allowed) {
        return c.json({ error: 'You can add credits yourself.', code: 'can_manage_billing' }, 409);
      }
      const result = await requestTopUp({
        accountId,
        requesterUserId: userId,
        requesterEmail: (c.get('userEmail') as string | undefined) ?? null,
      });
      if (!result) {
        return c.json({ error: 'You already asked the owners in the last 24 hours.', code: 'already_requested' }, 429);
      }
      return c.json(result, 202);
    },
  );
}
