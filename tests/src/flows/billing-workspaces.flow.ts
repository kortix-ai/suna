/**
 * Workspace-based billing (spec §20, `BILL-WS-*`; design.md §3.2 C6, review
 * finding 10).
 *
 * - The Free plan's monthly credits go to a person's first workspace only.
 *   A further workspace says so in its account-state: `free_grant.eligible`
 *   false, `tier.monthly_credits` 0, no reset date, and the workspace that
 *   holds the person's free credits (BILL-WS-1).
 * - A workspace split off a paid account holds that plan comped until the
 *   account's period ends, and account-state names the comp (BILL-WS-2).
 *
 * Every person here is a fresh synthetic user.
 */
import { flow } from '../core/flow';
import type { FlowContext, Principal } from '../core/types';
import { withDb } from '../fixtures/chat';

type FreeGrantState = {
  credits: { total: number; expires_at: string | null; can_run: boolean; free_grant?: { eligible: boolean; claimed_workspace_id: string | null } };
  tier: { monthly_credits: number };
  billing_state: string;
  plan?: { family: string };
  plan_comp?: { until: string; source: string } | null;
  model_access?: { managed: boolean };
};

async function accountState(ctx: FlowContext, who: Principal, accountId: string): Promise<FreeGrantState> {
  const r = await ctx.client.as(who).get('/v1/billing/account-state', { query: { account_id: accountId } });
  return r.status(200).json<FreeGrantState>();
}

async function secondWorkspace(ctx: FlowContext, who: Principal, slug: string): Promise<string> {
  const r = await ctx.client.as(who).post('/v1/accounts', { name: ctx.fixtures.name(slug) });
  r.status(201);
  const id = r.json<{ account_id: string }>().account_id;
  if (!id) throw new Error(`POST /v1/accounts returned no account_id: ${r.text()}`);
  return id;
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

flow(
  'BILL-WS-1',
  {
    domain: 'billing',
    requires: ['database'],
    routes: ['GET /v1/billing/account-state', 'POST /v1/accounts'],
  },
  async (ctx) => {
    const person = await ctx.fixtures.user({ label: 'BILLWS1-OWNER' });
    const first = person.accountId!;
    let second = '';

    await ctx.step("the person's first workspace holds the free credits: eligible, 500 credits a month, a reset date", async () => {
      const state = await accountState(ctx, person, first);
      expectEqual(state.credits.free_grant?.eligible, true, 'first workspace free_grant.eligible');
      expectEqual(state.tier.monthly_credits, 5, 'first workspace tier.monthly_credits (USD)');
      if (!state.credits.expires_at) throw new Error('the first workspace has no credit reset date');
      expectEqual(state.credits.can_run, true, 'first workspace can_run');
    });

    await ctx.step('a second workspace is created on Free with 0 credits (no cap on the number of workspaces)', async () => {
      second = await secondWorkspace(ctx, person, 'billws1-second');
      if (second === first) throw new Error('the second workspace reused the first account');
    });

    await ctx.step('the second workspace says it has no free credits and where they are: monthly_credits 0, no reset date', async () => {
      const state = await accountState(ctx, person, second);
      expectEqual(state.credits.free_grant, { eligible: false, claimed_workspace_id: first }, 'second workspace free_grant');
      expectEqual(state.tier.monthly_credits, 0, 'second workspace tier.monthly_credits');
      expectEqual(state.credits.expires_at, null, 'second workspace credits.expires_at');
      expectEqual(state.credits.total, 0, 'second workspace credits.total');
      expectEqual(state.credits.can_run, false, 'second workspace can_run');
      expectEqual(state.billing_state, 'no_subscription', 'second workspace billing_state');
    });

    await ctx.step('the database carries no grant date for the second workspace', async () => {
      const rows = await withDb(ctx, (db) =>
        db.query('SELECT free_credits_eligible, next_credit_grant FROM kortix.credit_accounts WHERE account_id = $1::uuid', [second]),
      );
      expectEqual(rows.rows[0], { free_credits_eligible: false, next_credit_grant: null }, 'second workspace credit row');
    });

    await ctx.step('another member of the second workspace never sees where this person holds free credits', async () => {
      const member = await ctx.fixtures.user({ label: 'BILLWS1-MEMBER', noAccount: true });
      await withDb(ctx, (db) =>
        db.query(
          `INSERT INTO kortix.account_members (account_id, user_id, account_role) VALUES ($1::uuid, $2::uuid, 'admin')`,
          [second, member.userId],
        ),
      );
      const state = await accountState(ctx, member, second);
      expectEqual(state.credits.free_grant, { eligible: false, claimed_workspace_id: null }, 'member view of free_grant');
    });

    await ctx.step('ANON → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get('/v1/billing/account-state', { query: { account_id: second } })).status(401);
    });
  },
);

flow(
  'BILL-WS-2',
  {
    domain: 'billing',
    requires: ['database'],
    routes: ['GET /v1/billing/account-state'],
  },
  async (ctx) => {
    const person = await ctx.fixtures.user({ label: 'BILLWS2-OWNER' });
    const comped = person.accountId!;
    const until = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

    await ctx.step('a workspace with no comp reports plan_comp null', async () => {
      expectEqual((await accountState(ctx, person, comped)).plan_comp, null, 'plan_comp before the comp');
    });

    await ctx.step('a split-off comp (paid plan, no Stripe subscription) is named in account-state with its end', async () => {
      // The state applySplitOffBilling writes for a split-off of a paid account.
      await withDb(ctx, (db) =>
        db.query(
          `UPDATE kortix.credit_accounts
              SET tier = 'credits', plan_monthly_usd = 300, comp_plan_until = $2::timestamptz,
                  free_credits_eligible = false, next_credit_grant = NULL, stripe_subscription_id = NULL
            WHERE account_id = $1::uuid`,
          [comped, until],
        ),
      );
      const state = await accountState(ctx, person, comped);
      expectEqual(state.plan_comp, { until, source: 'workspace_split' }, 'plan_comp');
      expectEqual(state.credits.expires_at, until, 'credits.expires_at is the comp end');
      expectEqual(state.plan?.family, 'credits', 'plan.family');
      expectEqual(state.tier.monthly_credits, 300, 'tier.monthly_credits');
      expectEqual(state.model_access?.managed, true, 'managed models come with the comped plan');
    });

    await ctx.step('an ended comp is no longer reported', async () => {
      await withDb(ctx, (db) =>
        db.query(`UPDATE kortix.credit_accounts SET comp_plan_until = now() - interval '1 minute' WHERE account_id = $1::uuid`, [comped]),
      );
      expectEqual((await accountState(ctx, person, comped)).plan_comp, null, 'plan_comp after the comp end');
    });
  },
);
