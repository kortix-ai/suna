import { isWebhookEventProcessed, recordWebhookEvent } from './webhook-concurrency';
import { WebhookError } from '../../errors';
import { getCreditAccount } from '../repositories/credit-accounts';
import { applyStripeSync } from './account-write-owner';
import { mapRevenueCatProductToTier, getRevenueCatPeriodType, isRevenueCatAnonymous, getMonthlyCredits, getTier } from './tiers';
import { wallet } from '../wallet';
import { cancelFreeSubscriptionForUpgrade } from './subscriptions';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { resolveAccountId } from '../../shared/resolve-account';
import { config } from '../../config';

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
    console.warn(`[RevenueCat] Ignoring SANDBOX ${eventType} (${eventId}) on production`);
    return { received: true, event_type: eventType, skipped: true };
  }

  const accountId = await resolveAccountId(appUserId);

  console.log(`[RevenueCat] Processing ${eventType} for ${appUserId} -> ${accountId}`);

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

  await recordWebhookEvent(dedupeKey, eventType);
  return { received: true, event_type: eventType, account_id: accountId };
}

async function handleRevenueCatPurchase(accountId: string, event: any, dedupeKey: string) {
  const productId = event.product_id;
  const tierKey = mapRevenueCatProductToTier(productId);
  if (!tierKey) {
    console.warn(`[RevenueCat] Unknown product ID: ${productId}`);
    return;
  }

  const existingAccount = await getCreditAccount(accountId);
  if (isDeletedBillingAccount(existingAccount)) {
    console.log(`[RevenueCat] Skipping INITIAL_PURCHASE for deleted account ${accountId}`);
    return;
  }

  const tier = getTier(tierKey);
  const periodType = getRevenueCatPeriodType(productId);

  const oldStripeSubscriptionId = existingAccount?.stripeSubscriptionId ?? null;

  await applyStripeSync(
    accountId,
    {
      tier: tierKey,
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
    console.log(`[RevenueCat] Trial INITIAL_PURCHASE for ${accountId}: no credit granted`);
  }

  if (!isTrial && tier.monthlyCredits > 0) {
    await wallet.grant({
      accountId,
      amount: tier.monthlyCredits,
      kind: 'tier_grant',
      description: `${tier.displayName} subscription (mobile): ${tier.monthlyCredits} credits`,
      expiring: true,
      key: { event: dedupeKey },
    });
  }

  const { MACHINE_CREDIT_BONUS } = await import('./tiers');
  if (!isTrial && MACHINE_CREDIT_BONUS > 0) {
    try {
      await wallet.grant({
        accountId,
        amount: MACHINE_CREDIT_BONUS,
        kind: 'machine_bonus',
        description: `Welcome credit bonus: $${MACHINE_CREDIT_BONUS}`,
        expiring: false,
        key: { event: `machine_bonus:revenuecat:${accountId}:${productId}` },
      });
      console.log(`[RevenueCat] Granted $${MACHINE_CREDIT_BONUS} machine bonus for ${accountId}`);
    } catch (err) {
      console.error(`[RevenueCat] Failed to grant machine bonus for ${accountId}:`, err);
    }
  }

  if (oldStripeSubscriptionId) {
    await cancelFreeSubscriptionForUpgrade(oldStripeSubscriptionId, accountId);
  }

  console.log(`[RevenueCat] Initial purchase: ${tierKey} for ${accountId}`);
}

async function handleRevenueCatRenewal(accountId: string, event: any, dedupeKey: string) {
  const account = await getCreditAccount(accountId);
  if (!account || isDeletedBillingAccount(account)) {
    console.log(`[RevenueCat] Skipping RENEWAL for missing or deleted account ${accountId}`);
    return;
  }

  const tierName = account.tier ?? 'free';
  const credits = getMonthlyCredits(tierName);

  if (credits > 0) {
    await wallet.reset({
      accountId,
      amount: credits,
      description: `Mobile renewal: ${credits} credits`,
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
    const tierKey = mapRevenueCatProductToTier(newProductId);
    if (tierKey) {
      await applyStripeSync(
        accountId,
        {
          tier: tierKey,
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
    description: `Mobile credit purchase: $${price.toFixed(2)}`,
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
  const tierKey = mapRevenueCatProductToTier(event.product_id);
  const dollars = tierKey ? getMonthlyCredits(tierKey) : Math.abs(Number(event.price) || 0);
  if (dollars <= 0) return;

  await wallet.grant({
    accountId,
    amount: -dollars,
    kind: 'admin_debit',
    description: `Store refund clawback: $${dollars.toFixed(2)}`,
    expiring: false,
    key: { event: `revenuecat-refund:${event.transaction_id ?? event.original_transaction_id ?? dedupeKey}` },
  });
  console.log(`[RevenueCat] Refund clawback: -$${dollars} for ${accountId}`);
}
