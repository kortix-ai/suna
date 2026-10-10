import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { getVisibleTiers } from '../services/tiers';
import { getCreditBalance } from '../repositories/credit-accounts';
import { getTransactionsSummary } from '../repositories/transactions';
import { makeOpenApiApp, json, auth } from '../../openapi';

export const creditsRouter = makeOpenApiApp<AppEnv>();

creditsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/tier-configurations',
    tags: ['billing'],
    summary: 'List visible tier configurations',
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
        }),
        'Visible tiers',
      ),
    },
  }),
  async (c) => {
    const tiers = getVisibleTiers().map((t) => ({
      name: t.name,
      display_name: t.displayName,
      monthly_price: t.monthlyPrice,
      yearly_price: t.yearlyPrice,
      monthly_credits: t.monthlyCredits,
      can_purchase_credits: t.canPurchaseCredits,
    }));

    return c.json({ tiers });
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
