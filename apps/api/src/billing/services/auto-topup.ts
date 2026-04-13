/**
 * Auto-topup service.
 *
 * When a Pro user's credit balance drops below their configured threshold,
 * we charge their Stripe default payment method off-session and grant credits.
 */

import { getStripe } from '../../shared/stripe';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { getCustomerByAccountId } from '../repositories/customers';
import { grantCredits } from './credits';
import { isPaidTier } from './tiers';
import { BillingError } from '../../errors';
import {
  AUTO_TOPUP_DEFAULT_AMOUNT,
  AUTO_TOPUP_DEFAULT_THRESHOLD,
  AUTO_TOPUP_MIN_AMOUNT,
  AUTO_TOPUP_MIN_THRESHOLD,
} from '@kortix/shared';

// ─── Validation Constants ────────────────────────────────────────────────────
export {
  AUTO_TOPUP_DEFAULT_AMOUNT,
  AUTO_TOPUP_DEFAULT_THRESHOLD,
  AUTO_TOPUP_MIN_AMOUNT,
  AUTO_TOPUP_MIN_THRESHOLD,
};

/** Minimum 60 seconds between auto-topup charges to prevent rapid-fire. */
const CHARGE_COOLDOWN_MS = 60_000;

// ─── Configure ──────────────────────────────────────────────────────────────

export interface AutoTopupConfig {
  enabled: boolean;
  threshold: number;  // dollars
  amount: number;     // dollars
}

export function validateAutoTopupConfig(cfg: AutoTopupConfig): string | null {
  if (!cfg.enabled) return null; // disabling always valid

  if (cfg.threshold < AUTO_TOPUP_MIN_THRESHOLD) {
    return `Threshold must be at least $${AUTO_TOPUP_MIN_THRESHOLD}`;
  }
  if (cfg.amount < AUTO_TOPUP_MIN_AMOUNT) {
    return `Reload amount must be at least $${AUTO_TOPUP_MIN_AMOUNT}`;
  }
  return null;
}

export async function configureAutoTopup(accountId: string, cfg: AutoTopupConfig) {
  const account = await getCreditAccount(accountId);
  if (!account) throw new BillingError('Account not found');

  const tierName = account.tier ?? 'free';
  if (!isPaidTier(tierName)) {
    throw new BillingError('Auto-topup is only available for paid plans');
  }

  const error = validateAutoTopupConfig(cfg);
  if (error) throw new BillingError(error);

  if (cfg.enabled) {
    const paymentMethodId = await getUsableAutoTopupPaymentMethodId(accountId);
    if (!paymentMethodId) {
      throw new BillingError('No default payment method found. Please set up a default card in Billing before enabling auto-topup.');
    }
  }

  await updateCreditAccount(accountId, {
    autoTopupEnabled: cfg.enabled,
    autoTopupThreshold: String(cfg.threshold),
    autoTopupAmount: String(cfg.amount),
  } as any);

  // If enabling and balance is already at or below threshold, charge immediately.
  if (cfg.enabled) {
    const balance = Number(account.balance) || 0;
    if (balance <= cfg.threshold) {
      void tryAutoTopup(accountId).catch((err) => {
        console.error(`[AutoTopup] Immediate charge failed for ${accountId}:`, err);
      });
    }
  }

  return { success: true };
}

export async function getAutoTopupSettings(accountId: string) {
  const account = await getCreditAccount(accountId);
  if (!account) return { enabled: true, threshold: AUTO_TOPUP_DEFAULT_THRESHOLD, amount: AUTO_TOPUP_DEFAULT_AMOUNT };

  return {
    enabled: Boolean(account.autoTopupEnabled),
    threshold: Number(account.autoTopupThreshold) || AUTO_TOPUP_DEFAULT_THRESHOLD,
    amount: Number(account.autoTopupAmount) || AUTO_TOPUP_DEFAULT_AMOUNT,
  };
}

export async function getAutoTopupSetupStatus(accountId: string) {
  const paymentStatus = await getAutoTopupPaymentStatus(accountId);
  return {
    has_payment_method: paymentStatus.hasAnyPaymentMethod,
    has_default_payment_method: paymentStatus.hasDefaultPaymentMethod,
  };
}

// ─── Trigger (called after credit deduction) ─────────────────────────────────

/**
 * Check if auto-topup should fire after a credit deduction.
 * Safe to call fire-and-forget — never throws, logs errors.
 */
export async function checkAndTriggerAutoTopup(accountId: string): Promise<void> {
  try {
    await tryAutoTopup(accountId);
  } catch (err) {
    console.error(`[AutoTopup] Error for ${accountId}:`, err);
  }
}

async function tryAutoTopup(accountId: string): Promise<void> {
  const account = await getCreditAccount(accountId);
  if (!account) return;
  if (!account.autoTopupEnabled) return;

  const tierName = account.tier ?? 'free';
  if (!isPaidTier(tierName)) return;

  const balance = Number(account.balance) || 0;
  const threshold = Number(account.autoTopupThreshold) || AUTO_TOPUP_DEFAULT_THRESHOLD;
  const amount = Number(account.autoTopupAmount) || AUTO_TOPUP_DEFAULT_AMOUNT;

  if (balance >= threshold) return;

  // Cooldown: don't charge more than once per CHARGE_COOLDOWN_MS
  if (account.autoTopupLastCharged) {
    const lastCharged = new Date(account.autoTopupLastCharged).getTime();
    if (Date.now() - lastCharged < CHARGE_COOLDOWN_MS) {
      console.log(`[AutoTopup] Cooldown active for ${accountId}, skipping`);
      return;
    }
  }

  // Find the Stripe customer
  const customer = await getCustomerByAccountId(accountId);
  if (!customer) {
    console.warn(`[AutoTopup] No Stripe customer for ${accountId}`);
    return;
  }

  const stripe = getStripe();

  // Resolve a payment method for off-session charging.
  // Stripe requires an attached/default PM for confirm=true + off_session.
  const paymentMethodId = await getUsableAutoTopupPaymentMethodId(accountId);

  if (!paymentMethodId) {
    console.warn(`[AutoTopup] No saved payment method for ${accountId}; auto-topup skipped`);
    return;
  }

  // Create an off-session payment intent using customer's default payment method
  try {
    const chargeWindow = Math.floor(Date.now() / CHARGE_COOLDOWN_MS);
    const idempotencyKey = `auto-topup:${accountId}:${amount.toFixed(2)}:${chargeWindow}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency: 'usd',
      customer: customer.id,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: `Auto-topup: $${amount} credits`,
      metadata: {
        account_id: accountId,
        type: 'auto_topup',
        threshold: String(threshold),
        amount: String(amount),
      },
    }, {
      idempotencyKey,
    });

    if (paymentIntent.status === 'succeeded') {
      // Grant non-expiring credits
      await grantCredits(
        accountId,
        amount,
        'purchase',
        `Auto-topup: $${amount.toFixed(2)} (balance was $${balance.toFixed(2)}, threshold $${threshold.toFixed(2)})`,
        false, // non-expiring
        paymentIntent.id,
      );

      await updateCreditAccount(accountId, {
        autoTopupLastCharged: new Date().toISOString(),
      } as any);

      console.log(`[AutoTopup] Charged $${amount} for ${accountId} (balance was $${balance.toFixed(2)})`);
    } else {
      console.warn(`[AutoTopup] Payment intent status: ${paymentIntent.status} for ${accountId}`);
    }
  } catch (err: any) {
    // Card declined or authentication required — log but don't crash
    console.error(`[AutoTopup] Payment failed for ${accountId}:`, err.message ?? err);

    // Mark last attempt to prevent rapid retries
    await updateCreditAccount(accountId, {
      autoTopupLastCharged: new Date().toISOString(),
    } as any);
  }
}

async function getUsableAutoTopupPaymentMethodId(accountId: string): Promise<string | null> {
  const status = await getAutoTopupPaymentStatus(accountId);
  return status.usablePaymentMethodId;
}

async function getAutoTopupPaymentStatus(accountId: string): Promise<{
  hasAnyPaymentMethod: boolean;
  hasDefaultPaymentMethod: boolean;
  usablePaymentMethodId: string | null;
}> {
  const customer = await getCustomerByAccountId(accountId);
  if (!customer) {
    return {
      hasAnyPaymentMethod: false,
      hasDefaultPaymentMethod: false,
      usablePaymentMethodId: null,
    };
  }

  const stripe = getStripe();

  try {
    let defaultPaymentMethodId: string | null = null;
    const stripeCustomer = await stripe.customers.retrieve(customer.id);
    if (!('deleted' in stripeCustomer) || !stripeCustomer.deleted) {
      const defaultPm = stripeCustomer.invoice_settings?.default_payment_method;
      if (typeof defaultPm === 'string') {
        defaultPaymentMethodId = defaultPm;
      } else if (defaultPm && typeof defaultPm === 'object' && 'id' in defaultPm) {
        defaultPaymentMethodId = defaultPm.id;
      }
    }

    const methods = await stripe.paymentMethods.list({
      customer: customer.id,
      type: 'card',
      limit: 1,
    });
    const firstCardId = methods.data[0]?.id ?? null;
    const hasAnyPaymentMethod = Boolean(firstCardId || defaultPaymentMethodId);

    return {
      hasAnyPaymentMethod,
      hasDefaultPaymentMethod: Boolean(defaultPaymentMethodId),
      usablePaymentMethodId: defaultPaymentMethodId ?? firstCardId,
    };
  } catch (err) {
    console.warn(`[AutoTopup] Could not resolve payment method for ${accountId}:`, err);
    return {
      hasAnyPaymentMethod: false,
      hasDefaultPaymentMethod: false,
      usablePaymentMethodId: null,
    };
  }
}
