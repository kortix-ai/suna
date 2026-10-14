import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { PLAN_MAX_MONTHLY_USD, PLAN_MIN_MONTHLY_USD, PLAN_PRESETS } from '../services/tiers';
import { getCreditBalance } from '../repositories/credit-accounts';
import { getTransactionsSummary } from '../repositories/transactions';
import { makeOpenApiApp, json, auth } from '../../openapi';

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
    },
  }),
  async (c) => {
    const accountId = c.get('userId');
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
    },
  }),
  async (c) => {
    const accountId = c.get('userId');
    const days = Number(c.req.query('days') ?? 30);
    const summary = await getTransactionsSummary(accountId, days);
    return c.json(summary);
  },
);
