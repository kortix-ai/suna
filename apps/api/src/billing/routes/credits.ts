import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { PLAN_MAX_MONTHLY_USD, PLAN_MIN_MONTHLY_USD, PLAN_PRESETS } from '../services/tiers';
import { getCreditBalance } from '../repositories/credit-accounts';
import { getTransactionsSummary } from '../repositories/transactions';
import { makeOpenApiApp, json, auth, errors } from '../../openapi';
import { resolveBillingReadAccountId, resolveBillingWriteAccountId } from '../http-require-billing-write';
import { CreditCodeError, redeemCreditCode } from '../services/credit-codes';

export const creditsRouter = makeOpenApiApp<AppEnv>();

creditsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/tier-configurations',
    tags: ['billing'],
    summary: 'List the credits plan tier ladder and amount bounds',
    ...auth,
    responses: {
      200: json(
        z.object({
          tiers: z.array(
            z.object({
              name: z.string(),
              display_name: z.string(),
              monthly_price: z.number(),
              yearly_price: z.number(),
              monthly_credits: z.number(),
              can_purchase_credits: z.boolean(),
            }),
          ),
          min_monthly_usd: z.number(),
          max_monthly_usd: z.number(),
        }),
        'Tier ladder: monthly amounts of the one credits plan; any whole amount in bounds',
      ),
    },
  }),
  async (c) => {
    // Each preset grants its price in credits (1 credit = $0.01): monthly_credits
    // stays in USD, as on every other billing response.
    const tiers = PLAN_PRESETS.map((p) => ({
      name: `credits_${p.monthlyUsd}`,
      display_name: `${(p.monthlyUsd * 100).toLocaleString('en-US')} credits`,
      monthly_price: p.monthlyUsd,
      yearly_price: 0,
      monthly_credits: p.monthlyUsd,
      can_purchase_credits: true,
    }));

    return c.json({ tiers, min_monthly_usd: PLAN_MIN_MONTHLY_USD, max_monthly_usd: PLAN_MAX_MONTHLY_USD });
  },
);

creditsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/credit-breakdown',
    tags: ['billing'],
    summary: 'Get the credit balance breakdown',
    ...auth,
    responses: {
      200: json(
        z.object({
          total: z.number(),
          expiring: z.number(),
          non_expiring: z.number(),
          daily: z.number(),
        }),
        'Credit breakdown',
      ),
      ...errors(403),
    },
  }),
  async (c) => {
    // The account the caller asked for (account_id), gated by billing.read,
    // like every sibling billing read; never the caller's personal account by
    // default (KRTX-2989).
    const accountId = await resolveBillingReadAccountId(c);
    const balance = await getCreditBalance(accountId);

    if (!balance) {
      return c.json({ total: 0, expiring: 0, non_expiring: 0, daily: 0 });
    }

    return c.json({
      total: Number(balance.balance),
      expiring: Number(balance.expiringCredits),
      non_expiring: Number(balance.nonExpiringCredits),
      daily: Number(balance.dailyCreditsBalance),
    });
  },
);

creditsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/usage-history',
    tags: ['billing'],
    summary: 'Get a credit usage summary over a window of days',
    ...auth,
    request: { query: z.object({ days: z.coerce.number().optional() }) },
    responses: {
      200: json(z.record(z.string(), z.any()), 'Usage summary'),
      ...errors(403),
    },
  }),
  async (c) => {
    const accountId = await resolveBillingReadAccountId(c);
    const days = Number(c.req.query('days') ?? 30);
    const summary = await getTransactionsSummary(accountId, days);
    return c.json(summary);
  },
);

creditsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/redeem-code',
    tags: ['billing'],
    summary: 'Redeem a credit code for an account',
    description:
      'Adds the code\'s amount to the account\'s non-expiring credits, once per account. ' +
      'Needs billing.write on the account. Error bodies carry `code`: credit_code_invalid (404), ' +
      'credit_code_expired (410), credit_code_exhausted (409), credit_code_already_redeemed (409).',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ code: z.string(), account_id: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          code: z.string(),
          amount_usd: z.number(),
          balance: z.number(),
        }),
        'The code was redeemed; amount_usd and balance are USD (1 USD = 100 credits)',
      ),
      404: json(z.object({ error: z.string(), code: z.string() }), 'Unknown or switched-off code'),
      409: json(z.object({ error: z.string(), code: z.string() }), 'Already redeemed, or no redemptions left'),
      410: json(z.object({ error: z.string(), code: z.string() }), 'The code has expired'),
      ...errors(400, 403, 429),
    },
  }),
  async (c) => {
    // billing.write: the code changes the account's wallet, so the same
    // owners and admins who may buy credits may redeem one. The write gate
    // also rate-limits guessing to 5 attempts a minute per account.
    const accountId = await resolveBillingWriteAccountId(c, 'body');
    const body = await c.req.json();
    try {
      const result = await redeemCreditCode({ accountId, userId: c.get('userId') ?? null, code: body.code });
      return c.json({ code: result.code, amount_usd: result.amountUsd, balance: result.balance?.balance ?? 0 }, 200);
    } catch (e) {
      if (e instanceof CreditCodeError) {
        return c.json({ error: e.message, code: e.code }, e.statusCode as 404 | 409 | 410);
      }
      throw e;
    }
  },
);
