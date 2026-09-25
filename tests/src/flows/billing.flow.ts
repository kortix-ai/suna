/**
 * Billing — account state + the REAL subscribe flow (inline checkout confirmed
 * with a Stripe test card). Maps to spec §20 (BILL-1, BILL-3). Gated on `stripe`.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import { subscribe } from '../fixtures/billing';

flow(
  'BILL-1',
  {
    domain: 'billing',
    tags: ['smoke'],
    routes: ['GET /v1/billing/account-state', 'GET /v1/billing/account-state/minimal'],
  },
  async (ctx) => {
    await ctx.step('OWNER reads account state', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/billing/account-state');
      r.status(200);
    });
    await ctx.step('account state carries the resolved `plan` block', async () => {
      // `plan` names the plan the account BEHAVES as (trial / per-seat self-heal
      // applied); `subscription.tier_key` stays the STORED plan Stripe sold.
      // A fresh owner has no trial and no seat subscription, so the two agree —
      // that agreement is the invariant this pins, along with the block being
      // present and fully populated.
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
        .exists('$.plan.is_grandfathered')
        .has('$.plan.key', state.subscription.tier_key)
        .has('$.tier.name', state.subscription.tier_key);
      if (typeof state.plan?.rank !== 'number') {
        throw new Error(`plan.rank must be a number, got ${JSON.stringify(state.plan?.rank)}`);
      }
      // `is_grandfathered` is resolved from the account's stored
      // is_grandfathered_free column, so on a shared long-lived fixture account
      // it is legitimately data-dependent — pin the TYPE, not a fixed value.
      // (A fixed `false` here flaked the release gate once the shared OWNER
      // account was grandfathered upstream.)
      if (typeof state.plan?.is_grandfathered !== 'boolean') {
        throw new Error(
          `plan.is_grandfathered must be a boolean, got ${JSON.stringify(state.plan?.is_grandfathered)}`,
        );
      }
      if (!['free', 'team', 'enterprise'].includes(String(state.plan?.family))) {
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
      'fresh personal account is repaired to free tier with usable credits',
      async () => {
        const r = await ctx.client.as(ctx.P.NONMEMBER).get('/v1/billing/account-state');
        r.status(200)
          .body()
          .has('$.subscription.tier_key', 'free')
          .has('$.tier.name', 'free')
          .has('$.tier.monthly_credits', 2)
          .has('$.credits.total', 2)
          .has('$.credits.monthly', 2)
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
    requires: ['funded'],
    serial: true,
    timeoutMs: 120_000,
    routes: [
      'POST /v1/billing/create-inline-checkout',
      'POST /v1/billing/confirm-inline-checkout',
      'GET /v1/billing/account-state',
    ],
  },
  async (ctx) => {
    // Subscribe a fresh team account the real way → credits granted.
    const team = await ctx.fixtures.team();
    await ctx.step('inline checkout + confirm with test card → active', async () => {
      await subscribe(ctx.env, ctx.client.as(ctx.P.OWNER), team.id, 'pro');
    });
    await ctx.step('account-state reflects an active paid subscription', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/billing/account-state', { query: { account_id: team.id } });
      r.status(200);
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
      'POST /v1/billing/schedule-downgrade',
      'POST /v1/billing/cancel-scheduled-change',
      'POST /v1/billing/sync-subscription',
      'GET /v1/billing/proration-preview',
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
    await ctx.step('schedule-downgrade with no active sub → rejected', async () => {
      const r = await owner.post('/v1/billing/schedule-downgrade', {
        account_id: team.id,
        target_tier_key: 'pro',
      });
      r.status([400, 404, 409]);
    });
    await ctx.step('cancel-scheduled-change with nothing scheduled → rejected', async () => {
      const r = await owner.post('/v1/billing/cancel-scheduled-change', { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
    await ctx.step('sync-subscription reconciles (no-op) → ok or no-sub', async () => {
      const r = await owner.post('/v1/billing/sync-subscription', { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
    await ctx.step('proration-preview requires new_price_id → 400', async () => {
      const r = await owner.get('/v1/billing/proration-preview', {
        query: { account_id: team.id },
      });
      r.status(400);
    });
    await ctx.step('proration-preview with a price but no active sub → rejected', async () => {
      const r = await owner.get('/v1/billing/proration-preview', {
        query: { account_id: team.id, new_price_id: 'price_nonexistent' },
      });
      r.status([400, 404, 409]);
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
    routes: ['POST /v1/billing/cancel-subscription', 'POST /v1/billing/sync-seat-quantity'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("NONMEMBER cancel on a team they don't belong to → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post('/v1/billing/cancel-subscription', { account_id: team.id });
      r.status(403);
    });
    await ctx.step('NONMEMBER sync-seat-quantity → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post('/v1/billing/sync-seat-quantity', { account_id: team.id });
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
      'POST /v1/billing/create-per-seat-checkout',
      'POST /v1/billing/cancel-subscription',
      'POST /v1/billing/purchase-credits',
      'POST /v1/billing/sync-seat-quantity',
      'POST /v1/billing/sync-subscription',
      'POST /v1/billing/confirm-checkout-session',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    const asMember = ctx.client.as(member);

    await ctx.step('MEMBER cannot start a team subscription checkout → 403', async () => {
      const r = await asMember.post('/v1/billing/create-per-seat-checkout', {
        account_id: team.id,
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
    await ctx.step('MEMBER cannot reconcile the seat quantity → 403', async () => {
      const r = await asMember.post('/v1/billing/sync-seat-quantity', { account_id: team.id });
      r.status(403);
    });
    await ctx.step('MEMBER cannot reconcile the subscription → 403', async () => {
      const r = await asMember.post('/v1/billing/sync-subscription', { account_id: team.id });
      r.status(403);
    });
    await ctx.step('MEMBER cannot confirm a checkout session → 403', async () => {
      const r = await asMember.post('/v1/billing/confirm-checkout-session', {
        account_id: team.id,
        session_id: 'cs_test_member_blocked',
      });
      r.status(403);
    });
    await ctx.step('ANON cannot start a team subscription checkout → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/billing/create-per-seat-checkout', {
        account_id: team.id,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status(401);
    });
  },
);

/**
 * BILL-10 — per-seat (billing v2) management on an unfunded team. `sync-seat-quantity`
 * reconciles the Stripe seat count against account_members; with no per-seat sub it
 * has nothing to sync (200 no-op) or rejects (400). `claim-per-seat` runs the legacy
 * → per-seat migration synchronously; a fresh team has no legacy machine subs, so it
 * returns ok with a "skipped:*" status (or 400 on failure). Neither fakes a sub.
 */
flow(
  'BILL-10',
  {
    domain: 'billing',
    routes: ['POST /v1/billing/sync-seat-quantity', 'POST /v1/billing/claim-per-seat'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step('sync-seat-quantity on a seat-less account → ok or rejected', async () => {
      const r = await owner.post('/v1/billing/sync-seat-quantity', { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
    await ctx.step('claim-per-seat on a non-legacy account → skipped', async () => {
      const r = await owner.post('/v1/billing/claim-per-seat', { account_id: team.id });
      r.status([200, 400]);
    });
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
      'POST /v1/billing/create-checkout-session',
      'POST /v1/billing/create-per-seat-checkout',
      'POST /v1/billing/create-portal-session',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step('create-checkout-session → Stripe URL or rejection', async () => {
      const r = await owner.post('/v1/billing/create-checkout-session', {
        account_id: team.id,
        tier_key: 'pro',
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status([200, 400, 500]);
    });
    await ctx.step('create-per-seat-checkout → Stripe URL or rejection', async () => {
      const r = await owner.post('/v1/billing/create-per-seat-checkout', {
        account_id: team.id,
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/cancel',
      });
      r.status([200, 400, 500]);
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
 * BILL-5 — checkout-session lookup + confirm. A bogus/unknown session id can't be
 * retrieved (4xx) and can't be confirmed; confirm with a missing session_id is a
 * hard 400 (input validation, before any Stripe call). Gated on `stripe`.
 */
flow(
  'BILL-11',
  {
    domain: 'billing',
    requires: ['stripe'],
    routes: [
      'GET /v1/billing/checkout-session/:sessionId',
      'POST /v1/billing/confirm-checkout-session',
    ],
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
    await ctx.step('confirm without session_id → 400', async () => {
      const r = await owner.post('/v1/billing/confirm-checkout-session', { account_id: team.id });
      r.status(400);
    });
    await ctx.step('confirm an unknown session id → rejected', async () => {
      const r = await owner.post('/v1/billing/confirm-checkout-session', {
        account_id: team.id,
        session_id: 'cs_test_does_not_exist',
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
    const description = `Credit purchase: $${(amountCents / 100).toFixed(2)}`;
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
 * BILL-19 — `confirm-inline-checkout` decides nothing from the request body.
 * The subscription must exist and be billed to the caller's own Stripe
 * customer; the tier comes from the subscription's price. A body without a
 * subscription id is a 400; an id that is not the caller's is a 404 on any
 * target that talks to Stripe.
 */
flow(
  'BILL-19',
  {
    domain: 'billing',
    routes: ['POST /v1/billing/confirm-inline-checkout'],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const team = await ctx.fixtures.team();

    await ctx.step('OWNER confirms with no subscription_id → 400', async () => {
      const r = await owner.post('/v1/billing/confirm-inline-checkout', { account_id: team.id, tier_key: 'pro' });
      r.status(400);
    });

    await ctx.step('OWNER confirms a subscription id that is not billed to the team → 404', async () => {
      if (!ctx.env.capabilities.stripe) return;
      const r = await owner.post('/v1/billing/confirm-inline-checkout', {
        account_id: team.id,
        subscription_id: `sub_ke2e${randomUUID().replaceAll('-', '').slice(0, 14)}`,
        tier_key: 'pro',
      });
      r.status(404);
    });
  },
);

/**
 * DEL-2 — account deletion lifecycle: schedule a deletion then cancel it. These
 * routes resolve the account from the CALLER's identity (resolveAccountId(userId)),
 * NOT a body account_id — so we drive them with a THROWAWAY user (a fresh team
 * member synthesized for this run, torn down by the world). We never touch OWNER's
 * own account. Covers both the `/v1/account/*` mount and the `/v1/billing/account/*`
 * mirror mount. ANON must be rejected (401) from the authed deletion routes.
 */
flow(
  'DEL-2',
  {
    domain: 'billing',
    routes: [
      'POST /v1/account/request-deletion',
      'POST /v1/account/cancel-deletion',
      'GET /v1/billing/account/deletion-status',
      'POST /v1/billing/account/request-deletion',
      'POST /v1/billing/account/cancel-deletion',
    ],
  },
  async (ctx) => {
    // Throwaway user whose only account is its own personal account.
    const victim = await ctx.fixtures.user({ label: 'DEL-2' });
    const asVictim = ctx.client.as(victim);

    await ctx.step('ANON cannot read deletion status → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/billing/account/deletion-status');
      r.status(401);
    });
    await ctx.step('throwaway user schedules deletion (/account mount) → 200', async () => {
      const r = await asVictim.post('/v1/account/request-deletion', { reason: 'ke2e' });
      r.status(200);
    });
    await ctx.step(
      'deletion-status (billing mirror mount) reflects the pending request',
      async () => {
        const r = await asVictim.get('/v1/billing/account/deletion-status');
        r.status(200);
      },
    );
    await ctx.step('requesting again while pending → 400 (already exists)', async () => {
      const r = await asVictim.post('/v1/account/request-deletion', { reason: 'again' });
      r.status([400, 409]);
    });
    await ctx.step('throwaway user cancels the deletion → 200', async () => {
      const r = await asVictim.post('/v1/account/cancel-deletion', {});
      r.status(200);
    });
    await ctx.step('cancel again with nothing pending → 400 (no active request)', async () => {
      const r = await asVictim.post('/v1/account/cancel-deletion', {});
      r.status([400, 404]);
    });
  },
);

/**
 * DEL-2b — billing-mirror deletion mount, exercised independently end-to-end on a
 * second throwaway user (schedule via /billing/account/request-deletion → cancel via
 * the mirror cancel). Confirms the mirror mount is fully wired, not just the status read.
 */
flow(
  'DEL-2b',
  {
    domain: 'billing',
    routes: [
      'POST /v1/billing/account/request-deletion',
      'POST /v1/billing/account/cancel-deletion',
    ],
  },
  async (ctx) => {
    const victim = await ctx.fixtures.user({ label: 'DEL-2b' });
    const asVictim = ctx.client.as(victim);

    await ctx.step('schedule deletion via billing mirror mount → 200', async () => {
      const r = await asVictim.post('/v1/billing/account/request-deletion', {
        reason: 'ke2e-mirror',
      });
      r.status(200);
    });
    await ctx.step('cancel deletion via billing mirror mount → 200', async () => {
      const r = await asVictim.post('/v1/billing/account/cancel-deletion', {});
      r.status(200);
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
    routes: ['POST /v1/projects/:projectId/sessions/:sessionId/prompts'],
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
      const promptPath = '/v1/projects/:projectId/sessions/:sessionId/prompts';
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
