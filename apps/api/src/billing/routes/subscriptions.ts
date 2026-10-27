import { assertAuthorized } from '../../iam/authorize';
import { actorOf } from '../../iam/actor';
import { ACCOUNT_ACTIONS } from '../../iam/actions';
import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import {
  createPortalSession,
  cancelSubscription,
  reactivateSubscription,
  syncSubscription,
  getCheckoutSessionDetails,
  parseMonthlyUsd,
  setPlan,
  previewPlan,
} from '../services/subscriptions';
import { resolveScopedAccountId } from '../../middleware/resolve-account';
import { resolveBillingWriteAccountId } from '../http-require-billing-write';
import { makeOpenApiApp, json, auth, errors } from '../../openapi';
import { readJsonObject } from '../../shared/http-body';

export const subscriptionsRouter = makeOpenApiApp<AppEnv>();

// Opaque Stripe / service payloads — permissive on purpose.
const OpaqueSchema = z.record(z.string(), z.any());
// Request bodies carry an optional account_id (read by resolveScopedAccountId)
// plus opaque, endpoint-specific fields. Manual parsing is kept everywhere here
// because the body is consumed twice (account resolution + handler) and the
// fields are forwarded to Stripe as-is.
const AnyBody = z.record(z.string(), z.any());

// The one plan change: any whole monthly amount on the credits plan. Starts a
// hosted checkout for an account with no paid subscription, otherwise changes
// the subscription in place (see setPlan).
subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/plan',
    tags: ['billing'],
    summary: 'Set the monthly credits plan amount',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: {
      200: json(OpaqueSchema, 'Plan change result'),
      ...errors(400, 429),
    },
  }),
  async (c) => {
    const accountId = await resolveBillingWriteAccountId(c, 'body');
    const body = await readJsonObject(c);
    const result = await setPlan({
      accountId,
      email: c.get('userEmail'),
      monthlyUsd: parseMonthlyUsd(body.monthly_usd),
      successUrl: String(body.success_url ?? ''),
      cancelUrl: String(body.cancel_url ?? ''),
      locale: typeof body.locale === 'string' ? body.locale : undefined,
    });
    return c.json(result);
  },
);

// What a plan change would do before the customer confirms it: the charge due
// now and the credits added now for a raise, the renewal date for a cut.
subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/plan/preview',
    tags: ['billing'],
    summary: 'Preview a change of the monthly credits plan amount',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: {
      200: json(OpaqueSchema, 'Plan change preview'),
      ...errors(400, 429),
    },
  }),
  async (c) => {
    const accountId = await resolveBillingWriteAccountId(c, 'body', 'preview');
    const body = await readJsonObject(c);
    return c.json(await previewPlan({ accountId, monthlyUsd: parseMonthlyUsd(body.monthly_usd) }));
  },
);

// "Talk to sales" from inside the app: one click, no form — the signed-in user
// and the account are known (billing/services/enterprise-sales.ts).
subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/enterprise/contact',
    tags: ['billing'],
    summary: 'Ask Kortix sales to get in touch about Enterprise',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: {
      200: json(z.object({ sent: z.boolean() }), 'Whether sales was emailed'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const accountId = await resolveScopedAccountId(c, 'body');
    await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.BILLING_READ);
    const body = await readJsonObject(c);
    const { resolveAccountBilling } = await import('../services/billing-cache');
    const { notifySales } = await import('../services/enterprise-sales');
    const sent = await notifySales({
      accountId,
      signal: 'contact',
      userEmail: c.get('userEmail') ?? null,
      enterprise: (await resolveAccountBilling(accountId)).enterprise,
      note: typeof body.note === 'string' ? body.note : null,
    });
    return c.json({ sent }, 200);
  },
);

// Accept an open Enterprise offer: a Stripe Checkout session for the contract
// an operator offered (billing/services/enterprise-contracts.ts). A fresh
// session per click: sessions expire within 24 h.
subscriptionsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/enterprise-offer/checkout',
    tags: ['billing'],
    summary: 'Accept the Enterprise offer: start its Stripe Checkout',
    ...auth,
    request: { body: { content: { 'application/json': { schema: AnyBody } } } },
    responses: {
      200: json(z.object({ checkout_url: z.string(), contract_id: z.string() }), 'Checkout to accept the offer'),
      ...errors(400, 404, 409, 429),
    },
  }),
  async (c) => {
    const accountId = await resolveBillingWriteAccountId(c, 'body');
    const body = await readJsonObject(c);
    const { createOfferCheckout } = await import('../services/enterprise-contracts');
    return c.json(
      await createOfferCheckout({
        accountId,
        email: c.get('userEmail'),
        successUrl: String(body.success_url ?? ''),
        cancelUrl: String(body.cancel_url ?? ''),
      }),
    );
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
    responses: { 200: json(OpaqueSchema, 'Portal session result'), ...errors(429) },
  }),
  async (c) => {
    const accountId = await resolveBillingWriteAccountId(c, 'body');
    const email = c.get('userEmail');
    const body = await c.req.json();
    const result = await createPortalSession(accountId, body.return_url, email);
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
    responses: { 200: json(OpaqueSchema, 'Cancellation result'), ...errors(429) },
  }),
  async (c) => {
    const accountId = await resolveBillingWriteAccountId(c, 'body');
    const body = await readJsonObject(c);
    const result = await cancelSubscription(
      accountId,
      typeof body.feedback === 'string' ? body.feedback : undefined,
    );
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
    responses: { 200: json(OpaqueSchema, 'Reactivation result'), ...errors(429) },
  }),
  async (c) => {
    const accountId = await resolveBillingWriteAccountId(c, 'body');
    const result = await reactivateSubscription(accountId);
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
    responses: { 200: json(OpaqueSchema, 'Sync result'), ...errors(404, 429) },
  }),
  async (c) => {
    const accountId = await resolveBillingWriteAccountId(c, 'body');
    const result = await syncSubscription(accountId);
    return c.json(result);
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
    responses: {
      200: json(OpaqueSchema, 'Checkout session details'),
      ...errors(404),
    },
  }),
  async (c) => {
    const accountId = await resolveScopedAccountId(c, 'query');
    const sessionId = c.req.param('sessionId');
    const result = await getCheckoutSessionDetails(accountId, sessionId);
    return c.json(result);
  },
);
