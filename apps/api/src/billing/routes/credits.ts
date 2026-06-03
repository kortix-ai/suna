import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { getVisibleTiers } from '../services/tiers';
import { getCreditBalance } from '../repositories/credit-accounts';
import { getTransactionsSummary } from '../repositories/transactions';

export const creditsRouter = new Hono<AppEnv>();

creditsRouter.get('/tier-configurations', async (c) => {
  const tiers = getVisibleTiers().map((t) => ({
    name: t.name,
    display_name: t.displayName,
    monthly_price: t.monthlyPrice,
    yearly_price: t.yearlyPrice,
    monthly_credits: t.monthlyCredits,
    can_purchase_credits: t.canPurchaseCredits,
  }));

  return c.json({ tiers });
});

creditsRouter.get('/credit-breakdown', async (c) => {
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
});

creditsRouter.get('/usage-history', async (c) => {
  const accountId = c.get('userId');
  const days = Number(c.req.query('days') ?? 30);
  const summary = await getTransactionsSummary(accountId, days);
  return c.json(summary);
});
