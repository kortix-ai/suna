import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { getStripe } from '../../shared/stripe';
import { getOrCreateStripeCustomer } from '../services/subscriptions';
import { canPurchaseCredits, resolveCreditPriceId } from '../services/tiers';
import { getCreditAccount } from '../repositories/credit-accounts';
import {
  getTransactions,
  getTransactionsSummary,
  getUsageRecords,
  insertPurchase,
} from '../repositories/transactions';
import { BillingError } from '../../errors';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { makeOpenApiApp, json, auth, errors } from '../../openapi';

export const paymentsRouter = makeOpenApiApp<AppEnv>();

// Opaque service/Stripe payloads — permissive on purpose.
const OpaqueSchema = z.record(z.string(), z.any());

paymentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/purchase-credits',
    tags: ['billing'],
    summary: 'Create a Stripe checkout session to purchase credits',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              amount: z.number(),
              account_id: z.string().optional(),
              success_url: z.string().optional(),
              cancel_url: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ checkout_url: z.string().nullable() }), 'Stripe checkout URL'),
      ...errors(400),
    },
  }),
  async (c) => {
    // Manual parse: resolveScopedAccountId also reads account_id from the body,
    // and the handler passes through opaque success/cancel URLs.
    const accountId = await resolveScopedAccountId(c, 'body');
    const email = c.get('userEmail');
    const body = await c.req.json();
    const amount = Number(body.amount);

    if (!amount || amount <= 0) throw new BillingError('Invalid amount');

    const account = await getCreditAccount(accountId);
    const tierName = account?.tier ?? 'free';

    if (!canPurchaseCredits(tierName)) {
      throw new BillingError('Your tier does not allow credit purchases');
    }

    const customerId = await getOrCreateStripeCustomer(accountId, email);
    const stripe = getStripe();

    const purchase = await insertPurchase({
      accountId,
      amountDollars: String(amount),
      status: 'pending',
      description: `$${amount} credit purchase`,
      provider: 'stripe',
    });

    const creditPriceId = resolveCreditPriceId(amount);
    const lineItems = creditPriceId
      ? [{ price: creditPriceId, quantity: 1 }]
      : [{
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amount * 100),
            product_data: { name: `$${amount} Credits` },
          },
          quantity: 1,
        }];

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: lineItems,
      success_url: body.success_url,
      cancel_url: body.cancel_url,
      metadata: {
        account_id: accountId,
        purchase_id: purchase!.id,
        type: 'credit_purchase',
      },
    });

    return c.json({ checkout_url: session.url });
  },
);

paymentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/transactions',
    tags: ['billing'],
    summary: 'List credit transactions (paginated)',
    ...auth,
    request: {
      query: z.object({
        account_id: z.string().optional(),
        limit: z.coerce.number().optional(),
        offset: z.coerce.number().optional(),
        type_filter: z.string().optional(),
      }),
    },
    responses: {
      200: json(
        z.object({
          transactions: z.array(
            z.object({
              id: z.string(),
              created_at: z.union([z.string(), z.date()]),
              amount: z.number(),
              balance_after: z.number(),
              type: z.string(),
              description: z.string().nullable(),
              is_expiring: z.boolean().nullable(),
              expires_at: z.union([z.string(), z.date()]).nullable(),
              metadata: z.any(),
            }),
          ),
          pagination: z.object({
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
            has_more: z.boolean(),
          }),
        }),
        'Transactions page',
      ),
    },
  }),
  async (c: any) => {
    const accountId = await resolveScopedAccountId(c, 'query');
    const limit = Number(c.req.query('limit') ?? 50);
    const offset = Number(c.req.query('offset') ?? 0);
    const typeFilterParam = c.req.query('type_filter') || undefined;
    const typeFilter = typeFilterParam?.includes(',')
      ? typeFilterParam.split(',').map((value: string) => value.trim()).filter(Boolean)
      : typeFilterParam;

    const { rows, total } = await getTransactions(accountId, limit, offset, typeFilter);

    const transactions = rows.map((r) => ({
      id: r.id,
      created_at: r.createdAt,
      amount: Number(r.amount),
      balance_after: Number(r.balanceAfter),
      type: r.type,
      description: r.description,
      is_expiring: r.isExpiring,
      expires_at: r.expiresAt,
      metadata: r.metadata,
    }));

    return c.json({
      transactions,
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + limit < total,
      },
    });
  },
);

paymentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/transactions/summary',
    tags: ['billing'],
    summary: 'Get a transaction summary over a window of days',
    ...auth,
    request: {
      query: z.object({ account_id: z.string().optional(), days: z.coerce.number().optional() }),
    },
    responses: {
      200: json(OpaqueSchema, 'Transaction summary'),
    },
  }),
  async (c) => {
    const accountId = await resolveScopedAccountId(c, 'query');
    const days = Number(c.req.query('days') ?? 30);
    const summary = await getTransactionsSummary(accountId, days);
    return c.json(summary);
  },
);

// ─── Auto-topup ──────────────────────────────────────────────────────────────

paymentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/auto-topup/settings',
    tags: ['billing'],
    summary: 'Get auto-topup settings',
    ...auth,
    request: { query: z.object({ account_id: z.string().optional() }) },
    responses: {
      200: json(OpaqueSchema, 'Auto-topup settings'),
    },
  }),
  async (c) => {
    const accountId = await resolveScopedAccountId(c, 'query');
    const { getAutoTopupSettings } = await import('../services/auto-topup');
    const settings = await getAutoTopupSettings(accountId);
    return c.json(settings);
  },
);

paymentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/auto-topup/setup-status',
    tags: ['billing'],
    summary: 'Get auto-topup setup status',
    ...auth,
    request: { query: z.object({ account_id: z.string().optional() }) },
    responses: {
      200: json(OpaqueSchema, 'Auto-topup setup status'),
    },
  }),
  async (c) => {
    const accountId = await resolveScopedAccountId(c, 'query');
    const { getAutoTopupSetupStatus } = await import('../services/auto-topup');
    const status = await getAutoTopupSetupStatus(accountId);
    return c.json(status);
  },
);

paymentsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/auto-topup/configure',
    tags: ['billing'],
    summary: 'Configure auto-topup',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              account_id: z.string().optional(),
              enabled: z.boolean().optional(),
              threshold: z.number().optional(),
              amount: z.number().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(OpaqueSchema, 'Auto-topup configuration result'),
    },
  }),
  async (c) => {
    const accountId = await resolveScopedAccountId(c, 'body');
    const body = await c.req.json();
    const { configureAutoTopup } = await import('../services/auto-topup');

    const result = await configureAutoTopup(accountId, {
      enabled: Boolean(body.enabled),
      threshold: Number(body.threshold),
      amount: Number(body.amount),
    });

    return c.json(result);
  },
);

// ─── Credit usage ────────────────────────────────────────────────────────────

paymentsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/credit-usage',
    tags: ['billing'],
    summary: 'List credit usage records (paginated)',
    ...auth,
    request: {
      query: z.object({
        account_id: z.string().optional(),
        limit: z.coerce.number().optional(),
        offset: z.coerce.number().optional(),
      }),
    },
    responses: {
      200: json(
        z.object({
          records: z.array(
            z.object({
              id: z.string(),
              amount_dollars: z.number(),
              description: z.string().nullable(),
              usage_type: z.string().nullable(),
              created_at: z.union([z.string(), z.date()]),
            }),
          ),
          count: z.number(),
        }),
        'Credit usage page',
      ),
    },
  }),
  async (c: any) => {
    const accountId = await resolveScopedAccountId(c, 'query');
    const limit = Number(c.req.query('limit') ?? 50);
    const offset = Number(c.req.query('offset') ?? 0);

    const { rows, total } = await getUsageRecords(accountId, limit, offset);

    const records = rows.map((r) => ({
      id: r.id,
      amount_dollars: Number(r.amountDollars),
      description: r.description,
      usage_type: r.usageType,
      created_at: r.createdAt,
    }));

    return c.json({ records, count: total });
  },
);
