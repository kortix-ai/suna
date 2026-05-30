import { Hono } from 'hono';
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

export const paymentsRouter = new Hono<AppEnv>();

paymentsRouter.post('/purchase-credits', async (c) => {
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
});

paymentsRouter.get('/transactions', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'query');
  const limit = Number(c.req.query('limit') ?? 50);
  const offset = Number(c.req.query('offset') ?? 0);
  const typeFilterParam = c.req.query('type_filter') || undefined;
  const typeFilter = typeFilterParam?.includes(',')
    ? typeFilterParam.split(',').map((value) => value.trim()).filter(Boolean)
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
});

paymentsRouter.get('/transactions/summary', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'query');
  const days = Number(c.req.query('days') ?? 30);
  const summary = await getTransactionsSummary(accountId, days);
  return c.json(summary);
});

// ─── Auto-topup ──────────────────────────────────────────────────────────────

paymentsRouter.get('/auto-topup/settings', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'query');
  const { getAutoTopupSettings } = await import('../services/auto-topup');
  const settings = await getAutoTopupSettings(accountId);
  return c.json(settings);
});

paymentsRouter.get('/auto-topup/setup-status', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'query');
  const { getAutoTopupSetupStatus } = await import('../services/auto-topup');
  const status = await getAutoTopupSetupStatus(accountId);
  return c.json(status);
});

paymentsRouter.post('/auto-topup/configure', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const body = await c.req.json();
  const { configureAutoTopup } = await import('../services/auto-topup');

  const result = await configureAutoTopup(accountId, {
    enabled: Boolean(body.enabled),
    threshold: Number(body.threshold),
    amount: Number(body.amount),
  });

  return c.json(result);
});

// ─── Credit usage ────────────────────────────────────────────────────────────

paymentsRouter.get('/credit-usage', async (c) => {
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
});
