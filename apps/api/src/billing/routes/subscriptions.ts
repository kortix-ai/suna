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
      ...errors(400),
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
    responses: { 200: json(OpaqueSchema, 'Cancellation result') },
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
    responses: { 200: json(OpaqueSchema, 'Reactivation result') },
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
    responses: { 200: json(OpaqueSchema, 'Sync result') },
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
