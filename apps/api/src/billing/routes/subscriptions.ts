import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import {
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  reactivateSubscription,
  scheduleDowngrade,
  cancelScheduledChange,
  syncSubscription,
  createPerSeatCheckoutSession,
} from '../services/subscriptions';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { syncSeatQuantity } from '../services/seat-management';
import { maybeMigrateLegacyAccount } from '../services/legacy-account-migration';

export const subscriptionsRouter = new Hono<AppEnv>();

// Billing v2 — legacy → per-seat voluntary "claim". Runs the SAME migration as
// the lazy sign-in path (create the $20/seat sub, cancel the legacy machine subs,
// pre-pay the first seat period out of the unused machine value + return the
// leftover as non-expiring credit, flip to per_seat) — but synchronously, so the
// billing UI can show the result. Lets legacy users who weren't auto-migrated
// (or where it silently skipped/failed) move themselves over with feedback.
subscriptionsRouter.post('/claim-per-seat', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const result = await maybeMigrateLegacyAccount(accountId);
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
});

subscriptionsRouter.post('/create-checkout-session', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const email = c.get('userEmail');
  const body = await c.req.json();

  const result = await createCheckoutSession({
    accountId,
    email,
    tierKey: body.tier_key,
    successUrl: body.success_url,
    cancelUrl: body.cancel_url,
    commitmentType: body.commitment_type,
    locale: body.locale,
    serverType: body.server_type,
    location: body.location,
  });

  return c.json(result);
});

// Billing v2 — per-seat plan checkout. Quantity is derived from current
// account_members count; Stripe handles proration on subsequent member changes.
subscriptionsRouter.post('/create-per-seat-checkout', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const email = c.get('userEmail');
  const body = await c.req.json();

  const result = await createPerSeatCheckoutSession({
    accountId,
    email,
    successUrl: body.success_url,
    cancelUrl: body.cancel_url,
    locale: body.locale,
  });

  return c.json(result);
});

// Billing v2 — manually trigger a seat-count reconciliation. The Stripe
// webhook normally handles this on member changes; this endpoint is a manual
// "kick" for ops / for handling cases where the webhook was dropped.
subscriptionsRouter.post('/sync-seat-quantity', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const result = await syncSeatQuantity(accountId);
  return c.json(result);
});

subscriptionsRouter.post('/create-portal-session', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const email = c.get('userEmail');
  const body = await c.req.json();
  const result = await createPortalSession(accountId, body.return_url, email);
  return c.json(result);
});

subscriptionsRouter.post('/cancel-subscription', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const body = await c.req.json().catch(() => ({}));
  const result = await cancelSubscription(accountId, body.feedback);
  return c.json(result);
});

subscriptionsRouter.post('/reactivate-subscription', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const result = await reactivateSubscription(accountId);
  return c.json(result);
});

subscriptionsRouter.post('/schedule-downgrade', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const body = await c.req.json();
  const result = await scheduleDowngrade(accountId, body.target_tier_key, body.commitment_type);
  return c.json(result);
});

subscriptionsRouter.post('/cancel-scheduled-change', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const result = await cancelScheduledChange(accountId);
  return c.json(result);
});

subscriptionsRouter.post('/sync-subscription', async (c) => {
  const accountId = await resolveScopedAccountId(c, 'body');
  const result = await syncSubscription(accountId);
  return c.json(result);
});
