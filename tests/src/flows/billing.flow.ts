/**
 * Billing — account state + the REAL subscribe flow (the credits plan, a Stripe
 * test-mode subscription adopted by our API). Maps to spec §20 (BILL-1, BILL-3).
 * Gated on `stripe`.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import { subscribe } from '../fixtures/billing';
import { PASSWORD } from '../fixtures/principals';
import { passwordGrantSession } from '../fixtures/supabase';

flow(
  'BILL-1',
  {
    domain: 'billing',
    tags: ['deployed', 'smoke'],
    routes: ['GET /v1/billing/account-state', 'GET /v1/billing/account-state/minimal'],
  },
  async (ctx) => {
    await ctx.step('OWNER reads account state', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/billing/account-state');
      r.status(200);
    });
    await ctx.step('account state carries the resolved `plan` block', async () => {
      // `plan` names the plan the account BEHAVES as (trial applied);
      // `subscription.tier_key` stays the STORED plan Stripe sold. A fresh owner
      // has no trial, so the two agree — that agreement is the invariant this
      // pins, along with the block being present and fully populated.
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/billing/account-state');
      const state = r.status(200).json<{
        plan?: Record<string, unknown>;
        subscription: { tier_key: string };
        tier: { name: string };
      }>();
      r.body()
        .exists('$.plan')
        .exists('$.plan.key')
        .exists('$.plan.family')
        .exists('$.plan.label')
        .exists('$.plan.status')
        .exists('$.plan.shape')
        .has('$.billing_model', undefined)
        .has('$.seats', undefined)
        .has('$.member_count', undefined)
        .has('$.plan.key', state.subscription.tier_key)
        .has('$.tier.name', state.subscription.tier_key);
      if (typeof state.plan?.rank !== 'number') {
        throw new Error(`plan.rank must be a number, got ${JSON.stringify(state.plan?.rank)}`);
      }
      // The shared OWNER may be free or paid on a long-lived target: pin the
      // TYPE of the amount, not a value.
      const monthly = state.plan?.monthly_usd;
      if (monthly !== null && typeof monthly !== 'number') {
        throw new Error(`plan.monthly_usd must be a number or null, got ${JSON.stringify(monthly)}`);
      }
      if (!['none', 'free', 'credits', 'enterprise'].includes(String(state.plan?.key))) {
        throw new Error(`plan.key must be one of the four plan keys, got ${String(state.plan?.key)}`);
      }
      if (!['free', 'credits', 'enterprise'].includes(String(state.plan?.family))) {
        throw new Error(`plan.family must be a public family, got ${String(state.plan?.family)}`);
      }
    });
    await ctx.step('OWNER reads the minimal account-state variant → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/billing/account-state/minimal');
      r.status(200);
    });
  },
);

flow(
  'BILL-12',
  {
    domain: 'billing',
    routes: ['GET /v1/billing/account-state'],
  },
  async (ctx) => {
    await ctx.step(
      'a freshly created account is on the free tier with usable credits',
      async () => {
        const r = await ctx.client.as(ctx.P.NONMEMBER).get('/v1/billing/account-state');
        r.status(200)
          .body()
          .has('$.subscription.tier_key', 'free')
          .has('$.tier.name', 'free')
          // Free = $5 (500 credits) a month since #10147. The API reports dollars.
          .has('$.tier.monthly_credits', 5)
          .has('$.credits.total', 5)
          .has('$.credits.monthly', 5)
          .has('$.credits.can_run', true)
          // billing_state is the unambiguous discriminator every client branches
          // on. A funded free account is `active`; `can_run:false` must never be
          // read as "no plan" (see billing/services/billing-state.ts).
          .has('$.billing_state', 'active')
          .has('$.has_active_subscription', false)
          // Lifetime rollups are maintained from credit_ledger. They read 0 on
          // every account before migration 20260729013905335 because nothing
          // had incremented them since the Python -> TS rewrite.
          .exists('$.credits.lifetime_granted')
          .exists('$.credits.lifetime_purchased')
          .exists('$.credits.lifetime_used');
      },
    );
  },
);

flow(
  'BILL-13',
  {
    domain: 'billing',
    tags: ['deployed'],
    serial: true,
    global: true,
    requires: ['internalCron'],
    routes: ['POST /v1/billing/cron/free-tier-rotation'],
  },
  async (ctx) => {
    await ctx.step('free-tier rotation cron route is wired to the reset service', async () => {
      const r = await ctx.client
        .withBearer(ctx.env.internalServiceKey!, 'INTERNAL_CRON')
        .post('/v1/billing/cron/free-tier-rotation', {});
      r.status(200).body().exists('$.processed').exists('$.skipped').exists('$.errors');
    });
  },
);

/**
 * BILL-16 — the yearly credit rotation cron (billing/index.ts). Same
 * `requireInternalCronAuth` gate as BILL-13's free-tier-rotation (Bearer or
 * X-Kortix-Internal-Key must timing-safe-equal INTERNAL_SERVICE_KEY), but
 * unlike BILL-13 we deliberately do NOT call this one with the real internal
 * key: a genuine yearly rotation grants/rolls real credits across every
 * account on the deployment, which is not something ke2e should ever trigger
 * for real, even against staging. Boundary-only: no/garbage credentials → 401,
 * proving the route is mounted and gated without ever reaching
 * processYearlyCreditRotation().
 */
flow(
  'BILL-16',
  {
    domain: 'billing',
    routes: ['POST /v1/billing/cron/yearly-rotation'],
  },
  async (ctx) => {
    await ctx.step('no credentials → 401 (route mounted + gated, rotation never runs)', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/billing/cron/yearly-rotation', {});
      r.status(401);
    });
    await ctx.step('wrong bearer → 401 (never the real internal key)', async () => {
      const r = await ctx.client
        .withBearer('ke2e-not-the-internal-key', 'WRONG_TOKEN')
        .post('/v1/billing/cron/yearly-rotation', {});
      r.status(401);
    });
  },
);

flow(
  'BILL-3',
  {
    domain: 'billing',
    tags: ['deployed'],
    requires: ['funded'],
    serial: true,
    timeoutMs: 120_000,
    routes: [
      'POST /v1/billing/plan',
      'POST /v1/billing/plan/preview',
      'POST /v1/billing/sync-subscription',
      'GET /v1/billing/account-state',
    ],
  },
  async (ctx) => {
    // Subscribe a fresh team account the real way → credits granted.
    const team = await ctx.fixtures.team();
    await ctx.step('credits plan at $50/month in Stripe test mode → active', async () => {
      await subscribe(ctx.env, ctx.client.as(ctx.P.OWNER), team.id, 50);
    });
    await ctx.step('account-state reports the credits plan at $50/month, no seats', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/billing/account-state', { query: { account_id: team.id } });
      r.status(200)
        .body()
        .has('$.subscription.tier_key', 'credits')
        .has('$.plan.key', 'credits')
        .has('$.plan.monthly_usd', 50)
        .has('$.tier.monthly_credits', 50)
        .has('$.seats', undefined);
    });
    await ctx.step('raising the plan to $100 charges the test card and reports $100', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/billing/plan', {
        account_id: team.id,
        monthly_usd: 100,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status(200).body().has('$.status', 'updated').has('$.change', 'raised').has('$.monthly_usd', 100);
      const state = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/billing/account-state', { query: { account_id: team.id } });
      state.status(200).body().has('$.plan.monthly_usd', 100);
    });
    await ctx.step('previewing a cut to $50 names the renewal date and nothing due now', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/billing/plan/preview', { account_id: team.id, monthly_usd: 50 });
      r.status(200).body().has('$.change', 'scheduled').has('$.due_now_usd', 0).has('$.current_monthly_usd', 100);
    });
    await ctx.step('a cut to $50 is scheduled: this period keeps $100, scheduled_change names $50', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/billing/plan', {
        account_id: team.id,
        monthly_usd: 50,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status(200).body().has('$.change', 'scheduled');
      const state = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/billing/account-state', { query: { account_id: team.id } });
      state.status(200).body().has('$.plan.monthly_usd', 100).has('$.subscription.scheduled_change.target_tier.monthly_usd', 50);
    });
    await ctx.step('choosing $100 again keeps the plan and clears the scheduled cut', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/billing/plan', {
        account_id: team.id,
        monthly_usd: 100,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status(200).body().has('$.change', 'kept');
      const state = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/billing/account-state', { query: { account_id: team.id } });
      state.status(200).body().has('$.plan.monthly_usd', 100).has('$.subscription.scheduled_change', null);
    });
  },
);

/**
 * BILL-20 — a plan change can be previewed before it is made. Without a paid
 * subscription the preview is Checkout: the first month due now and its
 * credits at once. Previewing writes nothing. It needs billing.write.
 */
flow(
  'BILL-20',
  {
    domain: 'billing',
    routes: ['POST /v1/billing/plan/preview', 'GET /v1/billing/account-state'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step('OWNER previews $300 on a free account → checkout, $300 and 30,000 credits now', async () => {
      const r = await owner.post('/v1/billing/plan/preview', { account_id: team.id, monthly_usd: 300 });
      r.status(200)
        .body()
        .has('$.change', 'checkout')
        .has('$.monthly_usd', 300)
        .has('$.current_monthly_usd', null)
        .has('$.due_now_usd', 300)
        .has('$.credits_now', 30_000)
        .has('$.effective_at', null);
    });
    await ctx.step('previewing changed nothing: the account is still on the free plan', async () => {
      const r = await owner.get('/v1/billing/account-state', { query: { account_id: team.id } });
      r.status(200).body().has('$.plan.family', 'free').has('$.subscription.scheduled_change', null);
    });
    await ctx.step('an amount off the ladder → 400', async () => {
      const r = await owner.post('/v1/billing/plan/preview', { account_id: team.id, monthly_usd: 25 });
      r.status(400);
    });
    await ctx.step('MEMBER cannot preview a plan change → 403', async () => {
      const member = await team.addMember('member');
      const r = await ctx.client.as(member).post('/v1/billing/plan/preview', { account_id: team.id, monthly_usd: 300 });
      r.status(403);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/billing/plan/preview', { account_id: team.id, monthly_usd: 300 });
      r.status(401);
    });
  },
);

/**
 * BILL-4 — subscription lifecycle management against an UNFUNDED team account.
 * The team has no Stripe subscription, so every management op is a real negative:
 * the service throws `SubscriptionError('No active subscription'|…)` → 400. We do
 * NOT fake a subscription; we assert the genuine "no subscription" rejection.
 * sync-subscription is permissive — it reconciles state and may legitimately 200
 * (nothing to sync) or 400.
 */
flow(
  'BILL-4',
  {
    domain: 'billing',
    routes: [
      'POST /v1/billing/cancel-subscription',
      'POST /v1/billing/reactivate-subscription',
      'POST /v1/billing/sync-subscription',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('cancel on a sub-less account → no subscription', async () => {
      const r = await owner.post('/v1/billing/cancel-subscription', { account_id: team.id });
      r.status([400, 404, 409]);
    });
    await ctx.step('reactivate on a sub-less account → no subscription', async () => {
      const r = await owner.post('/v1/billing/reactivate-subscription', { account_id: team.id });
      r.status([400, 404, 409]);
    });
    await ctx.step('sync-subscription reconciles (no-op) → ok or no-sub', async () => {
      const r = await owner.post('/v1/billing/sync-subscription', { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
  },
);

/**
 * BILL-4b — NONMEMBER cannot manage another account's subscription. The account
 * resolver rejects a non-member with 403 before any Stripe logic runs.
 */
flow(
  'BILL-4b',
  {
    domain: 'billing',
    routes: ['POST /v1/billing/cancel-subscription'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("NONMEMBER cancel on a team they don't belong to → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post('/v1/billing/cancel-subscription', { account_id: team.id });
      r.status(403);
    });
  },
);

/**
 * BILL-9 — `billing.write` IAM gate. Billing *write* ops resolve the account by
 * membership AND require `billing.write` (owners + the `billing_manager` policy
 * only — see iam/role-perms.ts). A plain account MEMBER has `billing.read` only,
 * so they're rejected with 403 BEFORE any Stripe call: a non-billing teammate
 * can't subscribe / cancel / top-up on the whole account's behalf. ANON → 401.
 * The OWNER-allowed path is covered by BILL-3b / BILL-4 (OWNER reaches the
 * business logic, never a 403). No `stripe`/`funded` requirement — the gate
 * fires before any Stripe interaction, mirroring BILL-4b's non-member 403.
 */
flow(
  'BILL-9',
  {
    domain: 'billing',
    routes: [
      'POST /v1/billing/plan',
      'POST /v1/billing/cancel-subscription',
      'POST /v1/billing/purchase-credits',
      'POST /v1/billing/sync-subscription',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    const asMember = ctx.client.as(member);

    await ctx.step('MEMBER cannot change the credits plan → 403', async () => {
      const r = await asMember.post('/v1/billing/plan', {
        account_id: team.id,
        monthly_usd: 100,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status(403);
    });
    await ctx.step('MEMBER cannot cancel the subscription → 403', async () => {
      const r = await asMember.post('/v1/billing/cancel-subscription', { account_id: team.id });
      r.status(403);
    });
    await ctx.step('MEMBER cannot buy credits → 403', async () => {
      const r = await asMember.post('/v1/billing/purchase-credits', {
        account_id: team.id,
        amount: 10,
      });
      r.status(403);
    });
    await ctx.step('MEMBER cannot reconcile the subscription → 403', async () => {
      const r = await asMember.post('/v1/billing/sync-subscription', { account_id: team.id });
      r.status(403);
    });
    await ctx.step('ANON cannot change the credits plan → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/billing/plan', {
        account_id: team.id,
        monthly_usd: 100,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status(401);
    });
  },
);

/**
 * BILL-10 — the plan amount is validated before any Stripe call: whole dollars
 * from 50 to 50,000 (PLAN_MAX_MONTHLY_USD). No `stripe` requirement — the 400
 * fires first. Every value here must be out of range: an in-range value reaches
 * Stripe, which the local profile does not have.
 */
flow(
  'BILL-10',
  {
    domain: 'billing',
    routes: ['POST /v1/billing/plan'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    for (const monthly_usd of [20, 49, 50_001, 75.5, 'fifty']) {
      await ctx.step(`monthly_usd ${JSON.stringify(monthly_usd)} → 400`, async () => {
        const r = await owner.post('/v1/billing/plan', {
          account_id: team.id,
          monthly_usd,
          success_url: 'https://example.com/ok',
          cancel_url: 'https://example.com/cancel',
        });
        r.status(400);
      });
    }
  },
);

/**
 * BILL-3b — Stripe-hosted checkout & portal sessions. These are REAL Stripe
 * test-mode calls: a successful call returns a Stripe-hosted URL (200); a config
 * or input problem surfaces as 400. We assert the [200,400] envelope rather than
 * pinning a single status, since it depends on the target's Stripe wiring.
 * Gated on `stripe` so credential-less targets self-skip.
 */
flow(
  'BILL-3b',
  {
    domain: 'billing',
    serial: true,
    requires: ['stripe'],
    timeoutMs: 60_000,
    routes: [
      'POST /v1/billing/plan',
      'POST /v1/billing/create-portal-session',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step('plan on a free team → hosted Checkout URL', async () => {
      const r = await owner.post('/v1/billing/plan', {
        account_id: team.id,
        monthly_usd: 100,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status(200).body().has('$.status', 'checkout_created').has('$.monthly_usd', 100).exists('$.checkout_url');
    });
    await ctx.step('create-portal-session → Stripe portal URL or rejection', async () => {
      const r = await owner.post('/v1/billing/create-portal-session', {
        account_id: team.id,
        return_url: 'https://example.com/return',
      });
      r.status([200, 400, 500]);
    });
  },
);

/**
 * BILL-11 — checkout-session lookup. A bogus/unknown session id can't be
 * retrieved (4xx). Gated on `stripe`.
 */
flow(
  'BILL-11',
  {
    domain: 'billing',
    requires: ['stripe'],
    routes: ['GET /v1/billing/checkout-session/:sessionId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step('lookup an unknown checkout session → 4xx', async () => {
      const r = await owner.get('/v1/billing/checkout-session/:sessionId', {
        params: { sessionId: 'cs_test_does_not_exist' },
      });
      r.status([400, 404, 500]);
    });
  },
);

/**
 * BILL-8 — billing webhooks are PUBLIC (no auth middleware) but verified at the
 * edge of the handler. Stripe: in-body HMAC signature — a missing `Stripe-Signature`
 * header is rejected with 400 BEFORE the body is parsed; an invalid signature is
 * also rejected (400, or 500 if the webhook secret isn't configured on the target).
 * RevenueCat: Bearer-token auth (NOT an in-body sig) — missing/wrong → 401 (or 500
 * if the secret isn't configured). Both mirror mounts (`/webhooks/*` and `/webhook/*`)
 * behave identically. ANON drives these — they must NOT require a session.
 */
flow(
  'BILL-8',
  {
    domain: 'billing',
    tags: ['deployed'],
    routes: [
      'POST /v1/billing/webhooks/stripe',
      'POST /v1/billing/webhook/stripe',
      'POST /v1/billing/webhooks/revenuecat',
      'POST /v1/billing/webhook/revenuecat',
    ],
  },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    const fakeEvent = { id: 'evt_ke2e', type: 'ping', data: { object: {} } };

    await ctx.step('stripe webhook, no Stripe-Signature → 400 missing sig', async () => {
      const r = await anon.post('/v1/billing/webhooks/stripe', fakeEvent);
      r.status(400);
    });
    await ctx.step('stripe webhook (mirror /webhook), no sig → 400', async () => {
      const r = await anon.post('/v1/billing/webhook/stripe', fakeEvent);
      r.status(400);
    });
    await ctx.step('stripe webhook, garbage signature → rejected (sig invalid)', async () => {
      const r = await anon.post('/v1/billing/webhooks/stripe', fakeEvent, {
        headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      });
      r.status([400, 500]);
    });
    await ctx.step('revenuecat webhook, no Bearer → 401 (or 500 if unconfigured)', async () => {
      const r = await anon.post('/v1/billing/webhooks/revenuecat', fakeEvent);
      r.status([401, 500]);
    });
    await ctx.step('revenuecat webhook (mirror /webhook), bad Bearer → 401', async () => {
      const r = await anon.post('/v1/billing/webhook/revenuecat', fakeEvent, {
        headers: { authorization: 'Bearer ke2e-wrong-token' },
      });
      r.status([401, 500]);
    });
  },
);

/**
 * BILL-18 — a one-off credit purchase grants credit only for SETTLED money.
 *
 * A delayed payment method (ACH debit) completes Stripe Checkout before the
 * funds arrive: `checkout.session.completed` carries `payment_status='unpaid'`.
 * That event must grant nothing. `checkout.session.async_payment_succeeded`
 * reports the settled payment and grants the purchase exactly once, however
 * often Stripe redelivers it. `async_payment_failed` grants nothing.
 *
 * The flow signs each event with the target's webhook secret, exactly as Stripe
 * does. The local profile starts the API with a fixed local secret; a deployed
 * target supplies its own through KE2E_STRIPE_WEBHOOK_SECRET. Without a secret
 * the signed steps skip themselves.
 */
flow(
  'BILL-18',
  {
    domain: 'billing',
    tags: ['deployed'],
    routes: [
      'POST /v1/billing/webhooks/stripe',
      'GET /v1/billing/account-state',
      'GET /v1/billing/transactions',
    ],
  },
  async (ctx) => {
    const secret = ctx.env.stripeWebhookSecret;
    const anon = ctx.client.as(ctx.P.ANON);
    const owner = ctx.client.as(ctx.P.OWNER);
    const team = await ctx.fixtures.team();
    const amountCents = 713;
    const description = `Credit purchase: ${amountCents.toLocaleString('en-US')} credits ($${(amountCents / 100).toFixed(2)})`;
    const sessionId = `cs_ke2e_${randomUUID().replaceAll('-', '')}`;

    const deliver = async (type: string, paymentStatus: 'paid' | 'unpaid', eventId = `evt_ke2e_${randomUUID().replaceAll('-', '')}`, session = sessionId) => {
      const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type,
        livemode: false,
        data: {
          object: {
            id: session,
            object: 'checkout.session',
            mode: 'payment',
            status: 'complete',
            payment_status: paymentStatus,
            amount_total: amountCents,
            currency: 'usd',
            payment_intent: null,
            metadata: { account_id: team.id, type: 'credit_purchase' },
          },
        },
      });
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', secret as string).update(`${ts}.${payload}`).digest('hex');
      return anon.post('/v1/billing/webhooks/stripe', payload, {
        headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` },
      });
    };
    const purchaseRows = async () => {
      const r = await owner.get('/v1/billing/transactions', {
        query: { account_id: team.id, limit: 100, type_filter: 'purchase' },
      });
      const body = r.status(200).json<{ transactions: Array<{ amount: number; description: string | null }> }>();
      return body.transactions.filter((row) => row.description === description);
    };
    const balance = async () => {
      const r = await owner.get('/v1/billing/account-state', { query: { account_id: team.id } });
      return Number(r.status(200).json<{ credits: { total: number } }>().credits.total);
    };

    let before = 0;
    await ctx.step('OWNER reads the team wallet before the purchase', async () => {
      before = await balance();
    });

    await ctx.step('a signed checkout.session.completed with payment_status=unpaid → 200 and no credit', async () => {
      if (!secret) return;
      (await deliver('checkout.session.completed', 'unpaid')).status(200);
      if ((await purchaseRows()).length !== 0) throw new Error('an unpaid checkout granted credit');
      const after = await balance();
      if (after !== before) throw new Error(`wallet moved on an unpaid checkout: ${before} → ${after}`);
    });

    const succeededEventId = `evt_ke2e_${randomUUID().replaceAll('-', '')}`;
    await ctx.step('async_payment_succeeded for the same session → 200 and exactly one purchase row', async () => {
      if (!secret) return;
      (await deliver('checkout.session.async_payment_succeeded', 'paid', succeededEventId)).status(200);
      const rows = await purchaseRows();
      if (rows.length !== 1) throw new Error(`expected 1 purchase row, found ${rows.length}`);
      if (Math.abs(Number(rows[0].amount) - amountCents / 100) > 0.001) {
        throw new Error(`purchase row amount ${rows[0].amount} != ${amountCents / 100}`);
      }
      const after = await balance();
      if (Math.abs(after - before - amountCents / 100) > 0.001) {
        throw new Error(`wallet should grow by ${amountCents / 100}: ${before} → ${after}`);
      }
    });

    await ctx.step('the same event redelivered → 200 deduped, still one purchase row', async () => {
      if (!secret) return;
      const r = await deliver('checkout.session.async_payment_succeeded', 'paid', succeededEventId);
      r.status(200).body().has('$.deduped', true);
      if ((await purchaseRows()).length !== 1) throw new Error('a redelivered event granted twice');
    });

    await ctx.step('a paid event for the same session under a new event id → 200, still one purchase row', async () => {
      if (!secret) return;
      (await deliver('checkout.session.completed', 'paid')).status(200);
      if ((await purchaseRows()).length !== 1) throw new Error('one session granted twice');
    });

    await ctx.step('async_payment_failed for another session → 200 and no credit', async () => {
      if (!secret) return;
      const failedSession = `cs_ke2e_${randomUUID().replaceAll('-', '')}`;
      (await deliver('checkout.session.async_payment_failed', 'unpaid', undefined, failedSession)).status(200);
      if ((await purchaseRows()).length !== 1) throw new Error('a failed payment granted credit');
    });
  },
);

/**
 * DEL-2 — account deletion lifecycle: schedule a deletion then cancel it. These
 * routes resolve the account from the CALLER's identity (resolveAccountId(userId)),
 * NOT a body account_id — so we drive them with a THROWAWAY user (a fresh team
 * member synthesized for this run, torn down by the world). We never touch OWNER's
 * own account. ANON must be rejected (401) from the authed deletion routes.
 */
flow(
  'DEL-2',
  {
    domain: 'billing',
    routes: [
      'POST /v1/account/request-deletion',
      'POST /v1/account/cancel-deletion',
      'GET /v1/account/deletion-status',
    ],
  },
  async (ctx) => {
    // Throwaway user whose only account is the one it created (POST /v1/accounts).
    const victim = await ctx.fixtures.user({ label: 'DEL-2' });
    let asVictim = ctx.client.as(victim);
    const signInAgain = async () => {
      if (!victim.email) throw new Error('synthetic deletion user has no email');
      const grant = await passwordGrantSession(ctx.env, victim.email, PASSWORD);
      asVictim = ctx.client.as({ ...victim, auth: { mode: 'bearer', token: grant.accessToken } });
    };

    await ctx.step('ANON cannot read deletion status → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/account/deletion-status');
      r.status(401);
    });
    await ctx.step('throwaway user schedules deletion (/account mount) → 200; it ends their sign-ins → 401', async () => {
      const r = await asVictim.post('/v1/account/request-deletion', { reason: 'ke2e' });
      r.status(200);
      // "Delete my account" deletes the person: the request ends every
      // sign-in, and the person signs in again to cancel it.
      (await asVictim.get('/v1/account/deletion-status')).status(401);
      await signInAgain();
    });
    let scheduledFor = '';
    await ctx.step('after signing in again, deletion-status reflects the pending request', async () => {
      const status = (await asVictim.get('/v1/account/deletion-status')).status(200);
      status.body().has('$.has_pending_deletion', true);
      scheduledFor = String(status.json<{ deletion_scheduled_for?: string }>().deletion_scheduled_for ?? '');
    });
    await ctx.step('requesting again while pending → 200 with the same date; the sign-in survives', async () => {
      const r = await asVictim.post('/v1/account/request-deletion', { reason: 'again' });
      r.status(200);
      const again = r.json<{ deletion_scheduled_for: string | null }>().deletion_scheduled_for;
      if (scheduledFor && again && Date.parse(again) !== Date.parse(scheduledFor)) throw new Error(`date moved: ${scheduledFor} → ${again}`);
      (await asVictim.get('/v1/account/deletion-status')).status(200).body().has('$.has_pending_deletion', true);
    });
    await ctx.step('throwaway user cancels the deletion → 200', async () => {
      const r = await asVictim.post('/v1/account/cancel-deletion', {});
      r.status(200);
    });
    await ctx.step('cancel again with nothing pending → 400 (no active request)', async () => {
      const r = await asVictim.post('/v1/account/cancel-deletion', {});
      r.status([400, 404]);
    });
    await ctx.step('scheduling again after a cancel → 200, and the status reads pending', async () => {
      const r = await asVictim.post('/v1/account/request-deletion', { reason: 'after-cancel' });
      r.status(200);
      await signInAgain();
      const status = await asVictim.get('/v1/account/deletion-status');
      status.status(200);
      const body = status.json<{ has_pending_deletion: boolean }>();
      if (body.has_pending_deletion !== true) {
        throw new Error(`expected has_pending_deletion=true after re-request, got ${JSON.stringify(body)}`);
      }
    });
    await ctx.step('cancel the second request → 200; status reads not pending', async () => {
      const r = await asVictim.post('/v1/account/cancel-deletion', {});
      r.status(200);
      const status = await asVictim.get('/v1/account/deletion-status');
      status.status(200);
      const body = status.json<{ has_pending_deletion: boolean }>();
      if (body.has_pending_deletion !== false) {
        throw new Error(`expected has_pending_deletion=false after cancel, got ${JSON.stringify(body)}`);
      }
    });
    await ctx.step('two concurrent requests → each 200 (or 401 once the other ended the sign-in); one request is pending', async () => {
      const [a, b] = await Promise.all([
        asVictim.post('/v1/account/request-deletion', { reason: 'race-a' }),
        asVictim.post('/v1/account/request-deletion', { reason: 'race-b' }),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      if (!statuses.includes(200) || !statuses.every((status) => status === 200 || status === 401)) {
        throw new Error(`expected 200 and 200/401, got ${JSON.stringify(statuses)}`);
      }
      await signInAgain();
      (await asVictim.get('/v1/account/deletion-status')).status(200).body().has('$.has_pending_deletion', true);
      const cleanup = await asVictim.post('/v1/account/cancel-deletion', {});
      cleanup.status(200);
    });
  },
);

/**
 * DEL-5 — deletion is an owner act. `addMember` inserts the membership
 * directly, so the member has no account of its own and resolves the TEAM as
 * its primary account. Every deletion route refuses the member with 403
 * `account.delete`, and the team survives.
 */
flow(
  'DEL-5',
  {
    domain: 'billing',
    routes: [
      'GET /v1/account/deletion-status',
      'GET /v1/account/deletion-plan',
      'POST /v1/account/cancel-deletion',
      'DELETE /v1/account/delete-immediately',
      'GET /v1/accounts/me',
      'GET /v1/accounts/:accountId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    const asMember = ctx.client.as(member);

    // "Delete my account" deletes the PERSON (design.md §3.1 item 2): a team
    // member leaves the team; the team is never deleted for them.
    await ctx.step('MEMBER reads their own deletion status and plan: nothing pending; they would leave the team', async () => {
      (await asMember.get('/v1/account/deletion-status')).status(200).body().has('$.has_pending_deletion', false);
      const plan = (await asMember.get('/v1/account/deletion-plan')).status(200).json<{ delete_workspaces: string[]; leave_workspaces: string[] }>();
      if (plan.delete_workspaces.length !== 0 || !plan.leave_workspaces.includes(team.id)) {
        throw new Error(`member plan ${JSON.stringify(plan)}`);
      }
    });
    await ctx.step('MEMBER has nothing to cancel → 400', async () => {
      (await asMember.post('/v1/account/cancel-deletion', {})).status(400);
    });
    await ctx.step('MEMBER deletes their account → 200: they leave the team, the team is untouched', async () => {
      (await asMember.del('/v1/account/delete-immediately')).status(200).body().has('$.leave_workspaces', [team.id]);
      (await asMember.get('/v1/accounts/me')).status(401);
    });
    await ctx.step('the team survives: OWNER reads it → 200', async () => {
      (await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId', { params: { accountId: team.id } })).status(200);
    });
  },
);

/**
 * BILL-17 — admitting a prompt debits nothing.
 *
 * `checkBillingActive` takes a real $0.01 admission hold, and only an LLM
 * gateway settle reconciles it. The prompt route called it as a yes/no check
 * and dropped `holdUsd`, so every accepted prompt cost the account one cent
 * that nothing ever refunded — labelled "LLM gateway admission hold" in the
 * transactions tab. Measured on one prod account: 115,810 holds, 9 real LLM
 * charges. The route must make the same decision without touching the wallet.
 */
flow(
  'BILL-17',
  {
    domain: 'billing',
    global: true,
    requires: ['database'],
    timeoutMs: 120_000,
    routes: ['POST /v1/workspaces/:projectId/sessions/:sessionId/prompts'],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const { randomUUID } = await import('node:crypto');
    const { Client } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new Client({
      connectionString: databaseUrl,
      ssl: local ? false : { rejectUnauthorized: false },
    });
    const team = await ctx.fixtures.team();
    // A dropped connection must fail the next query, not crash the runner.
    db.on('error', () => {});
    await db.connect();
    const sessionId = randomUUID();
    const blockerId = randomUUID();
    const wallet = async () => {
      const account = await db.query(
        'SELECT balance_precise::text AS balance FROM kortix.credit_accounts WHERE account_id = $1',
        [team.id],
      );
      const holds = await db.query(
        `SELECT count(*)::int AS n FROM kortix.credit_ledger
         WHERE account_id = $1 AND description = 'LLM gateway admission hold'`,
        [team.id],
      );
      return { balance: account.rows[0]?.balance as string, holds: holds.rows[0].n as number };
    };
    try {
      await db.query(
        `INSERT INTO kortix.credit_accounts
         (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
         VALUES ($1, 1000, 1000, 1000, 1000, 'tier_2_20')
         ON CONFLICT (account_id) DO UPDATE SET
           balance = 1000, balance_precise = 1000,
           non_expiring_credits = 1000, non_expiring_credits_precise = 1000,
           tier = 'tier_2_20'`,
        [team.id],
      );
      const project = await team.project({ managedGit: true });
      const params = { projectId: project.id, sessionId };
      const promptPath = '/v1/workspaces/:projectId/sessions/:sessionId/prompts';
      await db.query(
        `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility)
         VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4, 'project')`,
        [sessionId, team.id, project.id, ctx.P.OWNER.userId],
      );
      // A claimed row holds every prompt queued behind it, so the accepted
      // prompt below never reaches a runtime this flow does not provision.
      await db.query(
        `INSERT INTO kortix.session_lifecycle_commands
         (command_id, command_type, source, status, project_id, session_id, account_id,
          actor_user_id, payload, locked_by, locked_until)
         VALUES ($1, 'continue_session', 'ui', 'running', $2, $3, $4, $5,
           '{"text":"hello","clientMessageId":"bill-17-blocker"}'::jsonb, 'BILL-17', now() + interval '1 hour')`,
        [blockerId, project.id, sessionId, team.id, ctx.P.OWNER.userId],
      );
      const before = await wallet();

      await ctx.step('a funded account has its prompt accepted 202', async () => {
        const accepted = await owner.post(
          promptPath,
          {
            client_message_id: 'bill-17-prompt',
            message_id: 'msg_0123456789abAbCdEfGhIjKlMn',
            parts: [{ type: 'text', text: 'hello' }],
          },
          { params },
        );
        accepted.status(202).body().has('$.state', 'queued');
      });

      await ctx.step('the accepted prompt wrote no admission hold and moved no balance', async () => {
        const after = await wallet();
        if (after.holds !== before.holds) {
          throw new Error(
            `prompt admission wrote ${after.holds - before.holds} "LLM gateway admission hold" ledger row(s); nothing refunds them`,
          );
        }
        if (after.balance !== before.balance) {
          throw new Error(`prompt admission moved the balance ${before.balance} → ${after.balance}`);
        }
      });

      await ctx.step('a drained account is still refused 402 by the same route', async () => {
        await db.query(
          `UPDATE kortix.credit_accounts SET balance = 0, balance_precise = 0,
             non_expiring_credits = 0, non_expiring_credits_precise = 0,
             expiring_credits = 0, expiring_credits_precise = 0
           WHERE account_id = $1`,
          [team.id],
        );
        const refused = await owner.post(
          promptPath,
          {
            client_message_id: 'bill-17-drained',
            message_id: 'msg_0123456789abAbCdEfGhIjKlMo',
            parts: [{ type: 'text', text: 'hello' }],
          },
          { params },
        );
        refused.status(402).body().has('$.code', 'insufficient_credits');
      });
    } finally {
      await db.query('DELETE FROM kortix.session_lifecycle_commands WHERE session_id = $1', [sessionId]);
      await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]);
      await db.end();
    }
  },
);

/**
 * BILL-19 — "Talk to sales" from inside the app is one click: the signed-in
 * user and the account are known, so there is no form. Any member may ask
 * (`billing.read`); ANON may not. `sent` is whether sales was emailed: false on
 * a target with no `DEMO_LEAD_NOTIFY_EMAIL`, which is still a 200.
 */
flow(
  'BILL-19',
  {
    domain: 'billing',
    routes: ['POST /v1/billing/enterprise/contact'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/billing/enterprise/contact', { account_id: team.id });
      r.status(401);
    });
    await ctx.step('the OWNER asks → 200 with a boolean `sent`', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/billing/enterprise/contact', { account_id: team.id, note: 'SSO for 40 people' });
      r.status(200);
      if (typeof r.json<any>()?.sent !== 'boolean') throw new Error(`expected a boolean sent, got ${r.text()}`);
    });
    await ctx.step('a plain member may ask too → 200', async () => {
      const r = await ctx.client.as(member).post('/v1/billing/enterprise/contact', { account_id: team.id });
      r.status(200);
    });
  },
);

/**
 * BILL-22 — credit codes. Staff create a code worth $100; an owner redeems it
 * once for the account and the wallet's non-expiring bucket grows by exactly
 * that; every refusal names its reason. The code is unique per run, so a
 * re-run never meets a code an earlier run redeemed.
 */
flow(
  'BILL-22',
  {
    domain: 'billing',
    serial: true,
    routes: [
      'GET /v1/admin/api/credit-codes',
      'POST /v1/admin/api/credit-codes',
      'PATCH /v1/admin/api/credit-codes/:id',
      'POST /v1/billing/redeem-code',
    ],
  },
  async (ctx) => {
    const code = `KE2E${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const owner = ctx.client.as(ctx.P.OWNER);
    const nonMember = ctx.client.as(ctx.P.NONMEMBER);

    await ctx.step('ANON and a non-admin cannot create a code (401, 403)', async () => {
      (await ctx.client.as(ctx.P.ANON).post('/v1/admin/api/credit-codes', { code, amount_usd: 100 })).status(401);
      (await owner.post('/v1/admin/api/credit-codes', { code, amount_usd: 100 })).status(403);
    });

    await ctx.step('ANON cannot redeem (401); an unknown code → 404 credit_code_invalid', async () => {
      (await ctx.client.as(ctx.P.ANON).post('/v1/billing/redeem-code', { code })).status(401);
      (await owner.post('/v1/billing/redeem-code', { code, account_id: ctx.P.OWNER.accountId }))
        .status(404)
        .body()
        .has('$.code', 'credit_code_invalid');
    });

    if (!ctx.env.capabilities.admin) return;
    const admin = ctx.client.withBearer(ctx.env.adminToken!, 'ADMIN_TOKEN');

    let codeId = '';
    await ctx.step('admin creates the code, lower case in, upper case stored → 201', async () => {
      const r = await admin.post('/v1/admin/api/credit-codes', {
        code: code.toLowerCase(),
        amount_usd: 100,
        max_redemptions: 1,
        description: 'ke2e BILL-22',
      });
      const body = r.status(201).json<{ code: { code_id: string } }>();
      r.body()
        .has('$.code.code', code)
        .has('$.code.amount_usd', 100)
        .has('$.code.max_redemptions', 1)
        .has('$.code.redemption_count', 0)
        .has('$.code.active', true);
      codeId = body.code.code_id;
    });

    await ctx.step('the same code again → 409 credit_code_exists; a bad shape → 400', async () => {
      (await admin.post('/v1/admin/api/credit-codes', { code, amount_usd: 5 })).status(409).body().has('$.code', 'credit_code_exists');
      (await admin.post('/v1/admin/api/credit-codes', { code: 'no spaces', amount_usd: 5 })).status(400);
    });

    let before = 0;
    await ctx.step('read the OWNER non-expiring balance before redeeming', async () => {
      const r = await owner.get(`/v1/billing/credit-breakdown?account_id=${ctx.P.OWNER.accountId}`);
      before = r.status(200).json<{ non_expiring: number }>().non_expiring;
    });

    await ctx.step('OWNER redeems the code (case-insensitive, padded) → 200 amount_usd 100', async () => {
      const r = await owner.post('/v1/billing/redeem-code', { code: `  ${code.toLowerCase()} `, account_id: ctx.P.OWNER.accountId });
      r.status(200).body().has('$.code', code).has('$.amount_usd', 100).exists('$.balance');
    });

    await ctx.step('the non-expiring bucket grew by exactly 100, as one promotional ledger row', async () => {
      const r = await owner.get(`/v1/billing/credit-breakdown?account_id=${ctx.P.OWNER.accountId}`);
      const after = r.status(200).json<{ non_expiring: number }>().non_expiring;
      if (Math.abs(after - before - 100) > 1e-6) throw new Error(`non_expiring moved ${after - before}, want 100`);
      const t = await owner.get(`/v1/billing/transactions?account_id=${ctx.P.OWNER.accountId}&type_filter=promotional&limit=50`);
      const rows = t.status(200).json<{ transactions: Array<{ amount: number; description: string | null }> }>().transactions;
      const mine = rows.filter((row) => row.description === `Credit code ${code}`);
      if (mine.length !== 1 || mine[0]!.amount !== 100) throw new Error(`want one 100 row, got ${JSON.stringify(mine)}`);
    });

    await ctx.step('a second redemption by the same account → 409 credit_code_already_redeemed, no credit', async () => {
      (await owner.post('/v1/billing/redeem-code', { code, account_id: ctx.P.OWNER.accountId }))
        .status(409)
        .body()
        .has('$.code', 'credit_code_already_redeemed');
      const r = await owner.get(`/v1/billing/credit-breakdown?account_id=${ctx.P.OWNER.accountId}`);
      const after = r.status(200).json<{ non_expiring: number }>().non_expiring;
      if (Math.abs(after - before - 100) > 1e-6) throw new Error(`second redemption moved the balance to ${after}`);
    });

    await ctx.step('another account (the NONMEMBER primary account, no account_id) after the one redemption → 409 credit_code_exhausted', async () => {
      (await nonMember.post('/v1/billing/redeem-code', { code }))
        .status(409)
        .body()
        .has('$.code', 'credit_code_exhausted');
    });

    await ctx.step('the admin list shows redemption_count 1', async () => {
      const r = await admin.get('/v1/admin/api/credit-codes');
      const row = r.status(200).json<{ codes: Array<{ code: string; redemption_count: number }> }>().codes.find((c) => c.code === code);
      if (row?.redemption_count !== 1) throw new Error(`redemption_count ${row?.redemption_count}, want 1`);
    });

    await ctx.step('an expired code → 410; a switched-off code → 404', async () => {
      const expired = `${code}X`;
      (await admin.post('/v1/admin/api/credit-codes', { code: expired, amount_usd: 1, expires_at: '2020-01-01T00:00:00Z' })).status(201);
      (await nonMember.post('/v1/billing/redeem-code', { code: expired }))
        .status(410)
        .body()
        .has('$.code', 'credit_code_expired');

      const off = `${code}Y`;
      const created = (await admin.post('/v1/admin/api/credit-codes', { code: off, amount_usd: 1 })).status(201).json<{ code: { code_id: string } }>();
      (await admin.patch('/v1/admin/api/credit-codes/:id', { active: false }, { params: { id: created.code.code_id } }))
        .status(200)
        .body()
        .has('$.code.active', false);
      (await nonMember.post('/v1/billing/redeem-code', { code: off }))
        .status(404)
        .body()
        .has('$.code', 'credit_code_invalid');
    });

    await ctx.step('cleanup: switch the run code off', async () => {
      (await admin.patch('/v1/admin/api/credit-codes/:id', { active: false }, { params: { id: codeId } })).status(200);
    });
  },
);
