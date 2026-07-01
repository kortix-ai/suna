import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import type { AppEnv } from '../../types';
import {
  createCheckoutSession,
  createInlineCheckout,
  confirmInlineCheckout,
  createPortalSession,
  cancelSubscription,
  reactivateSubscription,
  scheduleDowngrade,
  cancelScheduledChange,
  syncSubscription,
  getCheckoutSessionDetails,
  confirmCheckoutSession,
  getProrationPreview,
  createPerSeatCheckoutSession,
} from '../services/subscriptions';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { resolveBillingWriteAccountId } from '../require-billing-write';
import { syncSeatQuantity } from '../services/seat-management';
import { maybeMigrateLegacyAccount } from '../services/legacy-account-migration';
import { makeOpenApiApp, json, auth, errors } from '../../openapi';
import {
  attemptBilling,
  parseJsonBody,
  parseOptionalJsonBody,
  runBillingEffect,
} from './effect-workflows';

export const subscriptionsRouter = makeOpenApiApp<AppEnv>();

// Opaque Stripe / service payloads — permissive on purpose.
const OpaqueSchema = z.record(z.string(), z.any());
// Request bodies carry an optional account_id (read by resolveScopedAccountId)
// plus opaque, endpoint-specific fields. Manual parsing is kept everywhere here
// because the body is consumed twice (account resolution + handler) and the
// fields are forwarded to Stripe as-is.
const AnyBody = z.record(z.string(), z.any());

// Billing v2 — legacy → per-seat voluntary "claim". Runs the SAME migration as
// the lazy sign-in path (create the $20/seat sub, cancel the legacy machine subs,
// pre-pay the first seat period out of the unused machine value + return the
// leftover as non-expiring credit, flip to per_seat) — but synchronously, so the
// billing UI can show the result. Lets legacy users who weren't auto-migrated
// (or where it silently skipped/failed) move themselves over with feedback.
subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/claim-per-seat',
    tags: ['billing'],
    summary: 'Voluntarily migrate a legacy account to per-seat pricing',
    ...auth,
    request: { body: { required: false, content: { 'application/json': { schema: AnyBody } } } },
    responses: {
      200: json(OpaqueSchema, 'Migration result'),
      ...errors(400),
    },
  }),
  async (c: any) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      return yield* attemptBilling(() => maybeMigrateLegacyAccount(accountId));
    }));

    if (result.status === 'failed') {
      return c.json({ ok: false, status: result.status, error: result.reason ?? 'Migration failed' }, 400);
    }
    return c.json({
      ok: true,
      status: result.status, // 'migrated' | 'skipped:already_per_seat' | 'skipped:no_subs' | …
      credited_usd: result.proratedCreditUsd,
      first_seat_covered_usd: result.firstSeatCoveredUsd,
      cancelled_subscriptions: result.cancelledSubIds.length,
      reason: result.reason ?? null,
    });
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/create-checkout-session',
    tags: ['billing'],
    summary: 'Create a Stripe checkout session for a subscription tier',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Checkout session result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      const email = c.get('userEmail');
      const body = yield* parseJsonBody<any>(c);

      return yield* attemptBilling(() =>
        createCheckoutSession({
          accountId,
          email,
          tierKey: body.tier_key,
          successUrl: body.success_url,
          cancelUrl: body.cancel_url,
          commitmentType: body.commitment_type,
          locale: body.locale,
          serverType: body.server_type,
          location: body.location,
        }),
      );
    }));

    return c.json(result);
  },
);

// Billing v2 — per-seat plan checkout. Quantity is derived from current
// account_members count; Stripe handles proration on subsequent member changes.
subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/create-per-seat-checkout',
    tags: ['billing'],
    summary: 'Create a per-seat plan checkout session',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Checkout session result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      const email = c.get('userEmail');
      const body = yield* parseJsonBody<any>(c);

      return yield* attemptBilling(() =>
        createPerSeatCheckoutSession({
          accountId,
          email,
          successUrl: body.success_url,
          cancelUrl: body.cancel_url,
          locale: body.locale,
        }),
      );
    }));

    return c.json(result);
  },
);

// Billing v2 — manually trigger a seat-count reconciliation. The Stripe
// webhook normally handles this on member changes; this endpoint is a manual
// "kick" for ops / for handling cases where the webhook was dropped.
subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sync-seat-quantity',
    tags: ['billing'],
    summary: 'Manually reconcile the per-seat subscription quantity',
    ...auth,
    request: { body: { required: false, content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Seat sync result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveScopedAccountId(c, 'body'));
      return yield* attemptBilling(() => syncSeatQuantity(accountId));
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/create-inline-checkout',
    tags: ['billing'],
    summary: 'Create an inline (no-redirect) checkout',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Inline checkout result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      const email = c.get('userEmail');
      const body = yield* parseJsonBody<any>(c);

      return yield* attemptBilling(() =>
        createInlineCheckout({
          accountId,
          email,
          tierKey: body.tier_key,
          billingPeriod: body.billing_period,
          promoCode: body.promo_code,
        }),
      );
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/confirm-inline-checkout',
    tags: ['billing'],
    summary: 'Confirm an inline checkout',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Inline checkout confirmation result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      const body = yield* parseJsonBody<any>(c);

      return yield* attemptBilling(() =>
        confirmInlineCheckout({
          accountId,
          subscriptionId: body.subscription_id,
          tierKey: body.tier_key,
        }),
      );
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/create-portal-session',
    tags: ['billing'],
    summary: 'Create a Stripe customer portal session',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Portal session result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      const email = c.get('userEmail');
      const body = yield* parseJsonBody<any>(c);
      return yield* attemptBilling(() => createPortalSession(accountId, body.return_url, email));
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/cancel-subscription',
    tags: ['billing'],
    summary: 'Cancel the active subscription',
    ...auth,
    request: { body: { required: false, content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Cancellation result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      const body = yield* parseOptionalJsonBody<{ feedback?: string }>(c, {});
      return yield* attemptBilling(() => cancelSubscription(accountId, body.feedback));
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/reactivate-subscription',
    tags: ['billing'],
    summary: 'Reactivate a cancelled subscription',
    ...auth,
    request: { body: { required: false, content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Reactivation result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      return yield* attemptBilling(() => reactivateSubscription(accountId));
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/schedule-downgrade',
    tags: ['billing'],
    summary: 'Schedule a downgrade to a lower tier',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Downgrade scheduling result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      const body = yield* parseJsonBody<any>(c);
      return yield* attemptBilling(() =>
        scheduleDowngrade(accountId, body.target_tier_key, body.commitment_type),
      );
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/cancel-scheduled-change',
    tags: ['billing'],
    summary: 'Cancel a scheduled subscription change',
    ...auth,
    request: { body: { required: false, content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Cancellation result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveBillingWriteAccountId(c, 'body'));
      return yield* attemptBilling(() => cancelScheduledChange(accountId));
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/sync-subscription',
    tags: ['billing'],
    summary: 'Sync subscription state from Stripe',
    ...auth,
    request: { body: { required: false, content: { 'application/json': { schema: AnyBody } } } },
    responses: { 200: json(OpaqueSchema, 'Sync result') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveScopedAccountId(c, 'body'));
      return yield* attemptBilling(() => syncSubscription(accountId));
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/proration-preview',
    tags: ['billing'],
    summary: 'Preview proration for a price change',
    ...auth,
    request: {
      query: z.object({ account_id: z.string().optional(), new_price_id: z.string().optional() }),
    },
    responses: {
      200: json(OpaqueSchema, 'Proration preview'),
      ...errors(400),
    },
  }),
  async (c: any) => {
    const response = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveScopedAccountId(c, 'query'));
      const newPriceId = c.req.query('new_price_id');
      if (!newPriceId) {
        return { status: 400, body: { error: 'new_price_id required' } };
      }

      const result = yield* attemptBilling(() => getProrationPreview(accountId, newPriceId));
      return { status: 200, body: result };
    }));

    return c.json(response.body, response.status as any);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/checkout-session/{sessionId}',
    tags: ['billing'],
    summary: 'Get details for a Stripe checkout session',
    ...auth,
    request: { params: z.object({ sessionId: z.string() }) },
    responses: { 200: json(OpaqueSchema, 'Checkout session details') },
  }),
  async (c) => {
    const result = await runBillingEffect(Effect.gen(function* () {
      const sessionId = c.req.param('sessionId');
      return yield* attemptBilling(() => getCheckoutSessionDetails(sessionId));
    }));

    return c.json(result);
  },
);

subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/confirm-checkout-session',
    tags: ['billing'],
    summary: 'Confirm a completed checkout session',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: {
      200: json(OpaqueSchema, 'Confirmation result'),
      ...errors(400),
    },
  }),
  async (c: any) => {
    const response = await runBillingEffect(Effect.gen(function* () {
      const accountId = yield* attemptBilling(() => resolveScopedAccountId(c, 'body'));
      const body = yield* parseJsonBody<{ session_id?: string }>(c);
      if (!body.session_id) {
        return { status: 400, body: { error: 'session_id required' } };
      }

      const result = yield* attemptBilling(() =>
        confirmCheckoutSession({
          accountId,
          sessionId: body.session_id!,
        }),
      );

      return { status: 200, body: result };
    }));

    return c.json(response.body, response.status as any);
  },
);
