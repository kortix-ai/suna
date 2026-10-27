import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { readAccountAutomationPause, setAccountAutomationsPaused, type AccountAutomationPause } from '../automation-pause';
import { ACCOUNT_ACTIONS } from '../../iam/actions';
import { actorOf } from '../../iam/actor';
import { assertAuthorized, authorize } from '../../iam/authorize';
import { readJsonObject } from '../../shared/http-body';
import { AccountIdParam, accountsRouter } from './app';

const AutomationsStatus = z.object({
  /** True while every automatic fire of every project of the account is stopped. */
  paused: z.boolean(),
  paused_at: z.string().nullable(),
  /** The user who paused them; null while running. */
  paused_by: z.string().nullable(),
  /** True when the caller may pause or resume (account.write). */
  can_change: z.boolean(),
});

function status(pause: AccountAutomationPause | null, canChange: boolean) {
  return {
    paused: pause !== null,
    paused_at: pause?.pausedAt.toISOString() ?? null,
    paused_by: pause?.pausedBy ?? null,
    can_change: canChange,
  };
}

/**
 * Pause all automations (KRTX-1721): one switch per account stops every
 * automatic fire in every project — schedules, reminders, webhooks, app events
 * and monitors (`accounts/automation-pause.ts`). Any member may read it; changing
 * it takes `account.write` (owners and admins by default).
 */
export function registerAutomationRoutes(): void {
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/automations',
      tags: ['accounts'],
      summary: "Whether the account's automations are paused",
      ...auth,
      request: { params: AccountIdParam },
      responses: {
        200: json(AutomationsStatus, 'Automation status'),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const { accountId } = c.req.valid('param');
      const actor = await actorOf(c, accountId);
      await assertAuthorized(actor, ACCOUNT_ACTIONS.ACCOUNT_READ);
      const canChange = (await authorize(actor, ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
      return c.json(status(await readAccountAutomationPause(accountId), canChange), 200);
    },
  );

  accountsRouter.openapi(
    createRoute({
      method: 'patch',
      path: '/{accountId}/automations',
      tags: ['accounts'],
      summary: 'Pause or resume every automation of the account',
      description:
        'paused: true stops every automatic fire in every project of the account: schedules, reminders, webhooks, ' +
        'connector events and App events. A manual fire still runs. Resuming fires a schedule slot missed while paused once.',
      ...auth,
      request: {
        params: AccountIdParam,
        body: { content: { 'application/json': { schema: z.object({ paused: z.boolean() }) } } },
      },
      responses: {
        200: json(AutomationsStatus, 'Automation status after the change'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (c) => {
      const { accountId } = c.req.valid('param');
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      // `paused` is required: `{}` must never flip the switch.
      const body = await readJsonObject(c);
      if (typeof body.paused !== 'boolean') return c.json({ error: 'paused (boolean) is required' }, 400);
      const pause = await setAccountAutomationsPaused({ accountId, paused: body.paused, userId: c.get('userId') as string });
      return c.json(status(pause, true), 200);
    },
  );
}
