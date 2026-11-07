import { isWebhookEventProcessed, recordWebhookEvent, withAccountLock } from './webhook-concurrency';
import { logger } from '../../lib/logger';
import { WebhookError } from '../../errors';
import { getCreditAccount } from '../repositories/credit-accounts';
import { applyStripeSync } from './account-write-owner';
import { getRevenueCatPeriodType, isRevenueCatAnonymous, planMonthlyUsd, revenueCatProductMonthlyUsd } from './tiers';
import { wallet } from '../wallet';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { isNoWorkspaceError } from '../../shared/no-workspace';
import { resolveAccountId } from '../../shared/resolve-account';
import { creditAccounts } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { accountRolesForUser } from '../../iam/read-models';
import { db } from '../../shared/db';
import { resolveCanonicalWorkspace } from '../../workspaces/surface';
import { config } from '../../config';
import { formatUsdAsCredits } from '@kortix/shared';
import { captureProductEvent, type ProductEvent } from '../../shared/product-analytics';

/** In-app store purchases as product events; `app_user_id` is the Supabase user id. */
const REVENUECAT_PRODUCT_EVENTS: Partial<Record<string, ProductEvent>> = {
  INITIAL_PURCHASE: 'subscription_activated',
  NON_RENEWING_PURCHASE: 'credits_topped_up',
  EXPIRATION: 'subscription_cancelled',
};

function captureRevenueCatProductEvent(
  eventType: string,
  appUserId: string,
  accountId: string,
  eventId: string,
  event: { product_id?: unknown; store?: unknown; price?: unknown; period_type?: unknown },
): void {
  const productEvent = REVENUECAT_PRODUCT_EVENTS[eventType];
  if (!productEvent) return;
  const productId = typeof event.product_id === 'string' ? event.product_id : null;
  const amountUsd =
    productEvent === 'credits_topped_up'
      ? Number(event.price) || null
      : productId
        ? revenueCatProductMonthlyUsd(productId)
        : null;
  captureProductEvent({
    userId: appUserId,
    accountId,
    event: productEvent,
    dedupeKey: `revenuecat:${eventId}`,
    properties: {
      store: typeof event.store === 'string' ? event.store.toLowerCase() : 'revenuecat',
      via: 'revenuecat_webhook',
      tier: 'credits',
      product_id: productId,
      amount_usd: amountUsd,
      trial: event.period_type === 'TRIAL',
    },
  });
}

/**
 * A deleted account keeps its row (ledger history, audit) but is terminal:
 * balances zeroed, tier free, `paymentStatus: 'deleted'` (account-deletion.ts).
 * A store subscription outlives that deletion — Apple/Google keep charging and
 * RevenueCat keeps posting RENEWAL / INITIAL_PURCHASE — so every RevenueCat
 * handler that grants credits or re-activates a tier must fail closed here.
 */
function isDeletedBillingAccount(account: { paymentStatus?: string | null } | null | undefined): boolean {
  return account?.paymentStatus === 'deleted';
}

/** The subscriber attribute the mobile app sets before a purchase: the workspace it buys for. */
export const REVENUECAT_WORKSPACE_ATTRIBUTE = 'kortix_workspace_id';

/**
 * The account a RevenueCat event bills. One person holds several workspaces,
 * so the person's id alone cannot say which one bought (Workspaces C6):
 *
 * 1. The account that already holds this store subscription
 *    (`revenuecat_subscription_id` = the original transaction): renewals,
 *    cancellations and product changes follow the purchase.
 * 2. The workspace the app named in the `kortix_workspace_id` subscriber
 *    attribute at purchase time, when the person is a member of it.
 * 3. Else the person's default account (`resolveAccountId`), as before.
 */
export async function resolveRevenueCatAccountId(
  appUserId: string,
  event: { original_transaction_id?: unknown; subscriber_attributes?: unknown },
): Promise<string> {
  const transaction = typeof event.original_transaction_id === 'string' ? event.original_transaction_id : null;
  if (transaction) {
    const [holder] = await db
      .select({ accountId: creditAccounts.accountId })
      .from(creditAccounts)
      .where(and(eq(creditAccounts.provider, 'revenuecat'), eq(creditAccounts.revenuecatSubscriptionId, transaction)));
    if (holder) return holder.accountId;
  }
  const attributes = (event.subscriber_attributes ?? {}) as Record<string, { value?: unknown } | undefined>;
  const named = attributes[REVENUECAT_WORKSPACE_ATTRIBUTE]?.value;
  if (typeof named === 'string' && named) {
    const workspace = await resolveCanonicalWorkspace(named).catch(() => null);
    if (workspace) {
      const roles = await accountRolesForUser(appUserId);
      if (roles.has(workspace.accountId)) return workspace.accountId;
      logger.warn('[RevenueCat] the named workspace is not the app user\'s; using the default account', { workspaceId: named });
    }
  }
  return resolveAccountId(appUserId);
}

export async function processRevenueCatWebhook(body: any) {
  const event = body?.event;
  if (!event) throw new WebhookError('Missing event in RevenueCat webhook');

  const eventType = event.type;
  const eventId = event.id ?? event.event_id;
  if (!eventId) throw new WebhookError('Missing event id');
  const appUserId = event.app_user_id;
  if (!appUserId) throw new WebhookError('Missing app_user_id');

  // Same marker contract as processStripeWebhook: checked first, written only
  // after the handler succeeded. Every handler below is keyed or idempotent.
  const dedupeKey = `revenuecat:${eventId}`;
  if (await isWebhookEventProcessed(dedupeKey)) {
    console.log(`[RevenueCat] Skipping duplicate ${eventType} (${eventId})`);
    return { received: true, event_type: eventType, deduped: true };
  }

  if (isRevenueCatAnonymous(appUserId)) {
    console.log(`[RevenueCat] Skipping anonymous user: ${appUserId}`);
    return { received: true, event_type: eventType, skipped: true };
  }

  // A store sandbox purchase (App Store sandbox, TestFlight, Play test track)
  // spends no real money. Production credit must never follow it: every new
  // sandbox event id would otherwise grant again.
  if (event.environment === 'SANDBOX' && config.INTERNAL_KORTIX_ENV === 'prod') {
    logger.warn(`[RevenueCat] Ignoring SANDBOX ${eventType} (${eventId}) on production`);
    return { received: true, event_type: eventType, skipped: true };
  }

  // A store user with no workspace has no account to credit. Acknowledge
  // (200) and skip: RevenueCat retries a non-2xx for days, and an account is
  // never created from a webhook. The event is not marked processed, so a
  // later redelivery after the person creates a workspace is handled then.
  let accountId: string;
  try {
    accountId = await resolveRevenueCatAccountId(appUserId, event);
  } catch (err) {
    if (!isNoWorkspaceError(err)) throw err;
    logger.warn(`[RevenueCat] Skipping ${eventType} (${eventId}): app user has no workspace`);
    return { received: true, event_type: eventType, skipped: true };
  }

  console.log(`[RevenueCat] Processing ${eventType} for ${appUserId} -> ${accountId}`);

  // One account's events apply one at a time, as the Stripe handlers do.
  await withAccountLock(accountId, () => applyRevenueCatEvent(accountId, eventType, event, dedupeKey));

  await recordWebhookEvent(dedupeKey, eventType);
  captureRevenueCatProductEvent(eventType, appUserId, accountId, eventId, event);
  return { received: true, event_type: eventType, account_id: accountId };
}

/** Lifecycle events that move the plan, as opposed to purchases that grant credit. */
const LIFECYCLE_EVENTS = new Set(['CANCELLATION', 'EXPIRATION', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'SUBSCRIPTION_PAUSED', 'BILLING_ISSUE']);

/**
 * Why a store lifecycle event must not move this account, or null when it
 * may. A store event speaks only for the store subscription the account is
 * on now:
 *   - the account is closed (`deleted` is terminal);
 *   - the account bills through another provider (a user who moved from the
 *     app to a Stripe plan is not downgraded by a late store EXPIRATION);
 *   - the event names another store product than the current one (an old
 *     product's EXPIRATION after a resubscribe or a product change);
 *   - an EXPIRATION whose period ended before the account's last store grant:
 *     a RENEWAL processed after that period end paid for a newer period, so
 *     the expiration is older than the state it would overwrite.
 */
function staleLifecycleReason(account: Awaited<ReturnType<typeof getCreditAccount>>, event: any): string | null {
  if (!account) return null;
  if (isDeletedBillingAccount(account)) return 'account is closed';
  if (account.provider && account.provider !== 'revenuecat') return `account bills through ${account.provider}`;
  const productId = typeof event.product_id === 'string' ? event.product_id : null;
  if (productId && account.revenuecatProductId && productId !== account.revenuecatProductId) {
    return `event product ${productId} is not the current product ${account.revenuecatProductId}`;
  }
  const expiresAtMs = event.expiration_at_ms == null ? NaN : Number(event.expiration_at_ms);
  if (event.type === 'EXPIRATION' && expiresAtMs > 0 && account.lastGrantDate) {
    if (new Date(account.lastGrantDate).getTime() > expiresAtMs) {
      return `a store grant at ${account.lastGrantDate} is newer than the period this expiration ends`;
    }
  }
  return null;
}

async function applyRevenueCatEvent(accountId: string, eventType: string, event: any, dedupeKey: string) {
  if (LIFECYCLE_EVENTS.has(eventType)) {
    const stale = staleLifecycleReason(await getCreditAccount(accountId), event);
    if (stale) {
      logger.info(`[RevenueCat] Ignoring ${eventType} for ${accountId}: ${stale}`);
      // A store refund still takes back what the store purchase granted.
      if (eventType === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT' && !stale.startsWith('account is closed')) {
        await clawBackRevenueCatRefund(accountId, event, dedupeKey);
      }
      return;
    }
  }

  switch (eventType) {
    case 'INITIAL_PURCHASE':
      await handleRevenueCatPurchase(accountId, event, dedupeKey);
      break;

    case 'RENEWAL':
      await handleRevenueCatRenewal(accountId, event, dedupeKey);
      break;

    case 'CANCELLATION':
    case 'EXPIRATION':
      await handleRevenueCatCancellation(accountId, event);
      if (eventType === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT') {
        await clawBackRevenueCatRefund(accountId, event, dedupeKey);
      }
      break;

    case 'UNCANCELLATION':
      await handleRevenueCatUncancellation(accountId, event);
      break;

    case 'PRODUCT_CHANGE':
      await handleRevenueCatProductChange(accountId, event);
      break;

    case 'NON_RENEWING_PURCHASE':
      await handleRevenueCatTopup(accountId, event, dedupeKey);
      break;

    case 'SUBSCRIPTION_PAUSED':
    case 'BILLING_ISSUE':
      await handleRevenueCatBillingIssue(accountId, event);
      break;

    default:
      console.log(`[RevenueCat] Unhandled event type: ${eventType}`);
  }
}

async function handleRevenueCatPurchase(accountId: string, event: any, dedupeKey: string) {
  const productId = event.product_id;
  const monthlyUsd = revenueCatProductMonthlyUsd(productId);
  if (monthlyUsd === null) {
    console.warn(`[RevenueCat] Unknown product ID: ${productId}`);
    return;
  }

  const existingAccount = await getCreditAccount(accountId);
  if (isDeletedBillingAccount(existingAccount)) {
    console.log(`[RevenueCat] Skipping INITIAL_PURCHASE for deleted account ${accountId}`);
    return;
  }

  const periodType = getRevenueCatPeriodType(productId);

  const oldStripeSubscriptionId = existingAccount?.stripeSubscriptionId ?? null;

  await applyStripeSync(
    accountId,
    {
      tier: 'credits',
      planMonthlyUsd: String(monthlyUsd),
      provider: 'revenuecat',
      paymentStatus: 'active',
      planType: periodType === 'yearly_commitment' ? 'yearly' : periodType,
      revenuecatProductId: productId,
      revenuecatCustomerId: event.subscriber_id ?? null,
      revenuecatSubscriptionId: event.original_transaction_id ?? event.subscriber_id ?? null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      autoTopupEnabled: true,
      autoTopupThreshold: String(AUTO_TOPUP_DEFAULT_THRESHOLD),
      autoTopupAmount: String(AUTO_TOPUP_DEFAULT_AMOUNT),
    },
    { account: existingAccount, reason: 'revenuecat.INITIAL_PURCHASE' },
  );

  // A free trial paid nothing. The credit comes with the first paid RENEWAL.
  const isTrial = event.period_type === 'TRIAL';
  if (isTrial) {
    logger.info(`[RevenueCat] Trial INITIAL_PURCHASE for ${accountId}: no credit granted`);
  }

  if (!isTrial && monthlyUsd > 0) {
    await wallet.grant({
      accountId,
      amount: monthlyUsd,
      kind: 'tier_grant',
      description: `Credits plan (mobile): ${monthlyUsd * 100} credits`,
      expiring: true,
      key: { event: dedupeKey },
    });
  }

  if (oldStripeSubscriptionId) {
    await cancelFreeSubscriptionForUpgrade(oldStripeSubscriptionId, accountId);
  }

  console.log(`[RevenueCat] Initial purchase: $${monthlyUsd}/mo for ${accountId}`);
}

async function handleRevenueCatRenewal(accountId: string, event: any, dedupeKey: string) {
  const account = await getCreditAccount(accountId);
  if (!account || isDeletedBillingAccount(account)) {
    console.log(`[RevenueCat] Skipping RENEWAL for missing or deleted account ${accountId}`);
    return;
  }

  const credits = revenueCatProductMonthlyUsd(account.revenuecatProductId ?? '') ?? planMonthlyUsd(account);

  if (credits > 0) {
    await wallet.reset({
      accountId,
      amount: credits,
      description: `Mobile renewal: ${Math.round(credits * 100)} credits`,
      key: { event: dedupeKey },
    });
  }

  await applyStripeSync(
    accountId,
    {
      provider: 'revenuecat',
      paymentStatus: 'active',
      lastGrantDate: new Date().toISOString(),
    },
    { account, mode: 'update', reason: 'revenuecat.RENEWAL' },
  );

  console.log(`[RevenueCat] Renewal: ${credits} credits for ${accountId}`);
}

async function handleRevenueCatCancellation(accountId: string, event: any) {
  const expirationDate = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  await applyStripeSync(
    accountId,
    {
      revenuecatCancelledAt: new Date().toISOString(),
      revenuecatCancelAtPeriodEnd: expirationDate,
      paymentStatus: event.type === 'EXPIRATION' ? 'failed' : 'active',
    },
    { mode: 'update', reason: `revenuecat.${event.type}` },
  );

  if (event.type === 'EXPIRATION') {
    await applyStripeSync(
      accountId,
      {
        tier: 'free',
        planMonthlyUsd: null,
        revenuecatProductId: null,
      },
      { mode: 'update', reason: 'revenuecat.EXPIRATION:revert' },
    );
  }

  console.log(`[RevenueCat] ${event.type}: ${accountId}`);
}

async function handleRevenueCatUncancellation(accountId: string, _event: any) {
  await applyStripeSync(
    accountId,
    {
      provider: 'revenuecat',
      revenuecatCancelledAt: null,
      revenuecatCancelAtPeriodEnd: null,
      paymentStatus: 'active',
    },
    { mode: 'update', reason: 'revenuecat.UNCANCELLATION' },
  );

  console.log(`[RevenueCat] Uncancellation: ${accountId}`);
}

async function handleRevenueCatProductChange(accountId: string, event: any) {
  const newProductId = event.new_product_id;
  const effectiveDate = event.effective_date
    ? new Date(event.effective_date).toISOString()
    : null;

  if (effectiveDate) {
    await applyStripeSync(
      accountId,
      {
        revenuecatPendingChangeProduct: newProductId,
        revenuecatPendingChangeDate: effectiveDate,
        revenuecatPendingChangeType: 'product_change',
      },
      { mode: 'update', reason: 'revenuecat.PRODUCT_CHANGE:pending' },
    );
  } else {
    const monthlyUsd = revenueCatProductMonthlyUsd(newProductId);
    if (monthlyUsd !== null) {
      await applyStripeSync(
        accountId,
        {
          tier: 'credits',
          planMonthlyUsd: String(monthlyUsd),
          provider: 'revenuecat',
          revenuecatProductId: newProductId,
          revenuecatPendingChangeProduct: null,
          revenuecatPendingChangeDate: null,
          revenuecatPendingChangeType: null,
        },
        { mode: 'update', reason: 'revenuecat.PRODUCT_CHANGE:applied' },
      );
    }
  }

  console.log(`[RevenueCat] Product change: ${accountId}`);
}

async function handleRevenueCatTopup(accountId: string, event: any, dedupeKey: string) {
  const account = await getCreditAccount(accountId);
  if (isDeletedBillingAccount(account)) {
    console.log(`[RevenueCat] Skipping NON_RENEWING_PURCHASE for deleted account ${accountId}`);
    return;
  }

  const price = event.price ? Number(event.price) : 0;
  if (price <= 0) return;

  await wallet.grant({
    accountId,
    amount: price,
    kind: 'purchase',
    description: `Mobile credit purchase: ${formatUsdAsCredits(price)} credits ($${price.toFixed(2)})`,
    expiring: false,
    key: { event: dedupeKey },
  });

  console.log(`[RevenueCat] Top-up: $${price} for ${accountId}`);
}

async function handleRevenueCatBillingIssue(accountId: string, event: any) {
  await applyStripeSync(
    accountId,
    {
      provider: 'revenuecat',
      paymentStatus: 'past_due',
      lastPaymentFailure: new Date().toISOString(),
    },
    { mode: 'update', reason: `revenuecat.${event?.type ?? 'BILLING_ISSUE'}` },
  );

  console.log(`[RevenueCat] Billing issue: ${accountId}`);
}

/**
 * A store refund arrives as CANCELLATION with cancel_reason CUSTOMER_SUPPORT.
 * Take back what the purchase granted: the pack price for a credit top-up, the
 * tier's monthly credit for a subscription. The balance may go negative.
 * Keyed on the store transaction, so a redelivery replays.
 */
async function clawBackRevenueCatRefund(accountId: string, event: any, dedupeKey: string) {
  const dollars = revenueCatProductMonthlyUsd(event.product_id ?? '') ?? Math.abs(Number(event.price) || 0);
  if (dollars <= 0) return;

  await wallet.grant({
    accountId,
    amount: -dollars,
    kind: 'admin_debit',
    description: `Store refund clawback: ${formatUsdAsCredits(dollars)} credits ($${dollars.toFixed(2)})`,
    expiring: false,
    key: { event: `revenuecat-refund:${event.transaction_id ?? event.original_transaction_id ?? dedupeKey}` },
  });
  logger.info(`[RevenueCat] Refund clawback: -$${dollars} for ${accountId}`);
}
