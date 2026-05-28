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

/** Minimum 60 seconds between successful auto-topup charges. */
const CHARGE_COOLDOWN_MS = 60_000;

/** Buffer above threshold the topup amount must add. Prevents config that loops forever. */
const AUTO_TOPUP_MIN_BUFFER = 1;

/** After this many consecutive failures the auto-topup is disabled; user must re-enable. */
const AUTO_TOPUP_MAX_CONSECUTIVE_FAILURES = 3;

/** Backoff between failed charge attempts. Index = failure count - 1. */
const FAILURE_BACKOFF_MS = [5 * 60_000, 30 * 60_000];

/**
 * Stripe decline codes that warrant immediate auto-disable (no point retrying).
 * Anything else is treated as transient (backoff but keep enabled until the
 * consecutive-failures cap is reached).
 */
const HARD_DECLINE_CODES = new Set([
  'card_declined',
  'insufficient_funds',
  'do_not_honor',
  'expired_card',
  'incorrect_cvc',
  'stolen_card',
  'lost_card',
  'pickup_card',
  'fraudulent',
  'authentication_required',
]);

/** Per-account in-process mutex: dedup concurrent triggers within a single API instance. */
const inFlight = new Map<string, Promise<void>>();

// ─── Configure ──────────────────────────────────────────────────────────────

export interface AutoTopupConfig {
  enabled: boolean;
  threshold: number;  // dollars
  amount: number;     // dollars
}

export function validateAutoTopupConfig(cfg: AutoTopupConfig): string | null {
  if (!cfg.enabled) return null;

  if (cfg.threshold < AUTO_TOPUP_MIN_THRESHOLD) {
    return `Threshold must be at least $${AUTO_TOPUP_MIN_THRESHOLD}`;
  }
  if (cfg.amount < AUTO_TOPUP_MIN_AMOUNT) {
    return `Reload amount must be at least $${AUTO_TOPUP_MIN_AMOUNT}`;
  }
  // Without this, a topup of $5 with threshold $5 would re-trigger on every
  // subsequent debit and charge the user repeatedly. Force the topup to push
  // the balance comfortably above the threshold.
  if (cfg.amount < cfg.threshold + AUTO_TOPUP_MIN_BUFFER) {
    return `Reload amount must be at least $${AUTO_TOPUP_MIN_BUFFER} above the threshold (got amount=$${cfg.amount}, threshold=$${cfg.threshold})`;
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

  const update: Record<string, unknown> = {
    autoTopupEnabled: cfg.enabled,
    autoTopupThreshold: String(cfg.threshold),
    autoTopupAmount: String(cfg.amount),
  };
  // Manual re-enable wipes the backoff state: user is explicitly attesting
  // their payment method is fixed.
  if (cfg.enabled) {
    update.autoTopupConsecutiveFailures = 0;
    update.autoTopupDisabledReason = null;
    update.autoTopupLastCharged = null;
  }
  await updateCreditAccount(accountId, update as any);

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
  const existing = inFlight.get(accountId);
  if (existing) {
    return existing;
  }
  const task = (async () => {
    try {
      await tryAutoTopup(accountId);
    } catch (err) {
      console.error(`[AutoTopup] Error for ${accountId}:`, err);
    } finally {
      inFlight.delete(accountId);
    }
  })();
  inFlight.set(accountId, task);
  return task;
}

async function tryAutoTopup(accountId: string): Promise<void> {
  const account = await getCreditAccount(accountId);
  if (!account) return;
  if (!account.autoTopupEnabled) return;

  const tierName = account.tier ?? 'free';
  if (!isPaidTier(tierName)) return;

  const threshold = Number(account.autoTopupThreshold) || AUTO_TOPUP_DEFAULT_THRESHOLD;
  const amount = Number(account.autoTopupAmount) || AUTO_TOPUP_DEFAULT_AMOUNT;
  const previousFailures = Number(account.autoTopupConsecutiveFailures) || 0;

  if ((Number(account.balance) || 0) >= threshold) return;

  // Backoff: success cooldown = 60s; failure cooldown escalates (5min → 30min).
  if (account.autoTopupLastCharged) {
    const elapsed = Date.now() - new Date(account.autoTopupLastCharged).getTime();
    const requiredCooldown = previousFailures > 0
      ? (FAILURE_BACKOFF_MS[Math.min(previousFailures - 1, FAILURE_BACKOFF_MS.length - 1)] ?? CHARGE_COOLDOWN_MS)
      : CHARGE_COOLDOWN_MS;
    if (elapsed < requiredCooldown) {
      console.log(`[AutoTopup] cooldown active for ${accountId} (${Math.round(elapsed / 1000)}s / ${Math.round(requiredCooldown / 1000)}s, failures=${previousFailures}), skipping`);
      return;
    }
  }

  const customer = await getCustomerByAccountId(accountId);
  if (!customer) {
    console.warn(`[AutoTopup] No Stripe customer for ${accountId}`);
    return;
  }

  const paymentMethodId = await getUsableAutoTopupPaymentMethodId(accountId);
  if (!paymentMethodId) {
    console.warn(`[AutoTopup] No saved payment method for ${accountId}; auto-topup skipped`);
    return;
  }

  // TOCTOU re-check: another deduction or manual top-up could have changed
  // the balance between the initial check and now. Re-read just before
  // committing to a Stripe call.
  const fresh = await getCreditAccount(accountId);
  if (!fresh || !fresh.autoTopupEnabled) return;
  const freshBalance = Number(fresh.balance) || 0;
  if (freshBalance >= threshold) {
    console.log(`[AutoTopup] balance reached threshold during pre-flight (${freshBalance} >= ${threshold}); skipping`);
    return;
  }

  const stripe = getStripe();
  try {
    const chargeWindow = Math.floor(Date.now() / CHARGE_COOLDOWN_MS);
    const idempotencyKey = `auto-topup:${accountId}:${amount.toFixed(2)}:${chargeWindow}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
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
      await grantCredits(
        accountId,
        amount,
        'purchase',
        `Auto-topup: $${amount.toFixed(2)} (balance was $${freshBalance.toFixed(2)}, threshold $${threshold.toFixed(2)})`,
        false,
        paymentIntent.id,
      );
      await updateCreditAccount(accountId, {
        autoTopupLastCharged: new Date().toISOString(),
        autoTopupConsecutiveFailures: 0,
        autoTopupDisabledReason: null,
      } as any);
      console.log(`[AutoTopup] charged $${amount} for ${accountId} (balance was $${freshBalance.toFixed(2)})`);
    } else {
      // Pending / requires_action / requires_payment_method — count as a soft
      // failure so we back off, but don't auto-disable.
      await handleFailedCharge(accountId, previousFailures, `payment_intent_status:${paymentIntent.status}`, false);
      console.warn(`[AutoTopup] payment intent status: ${paymentIntent.status} for ${accountId}`);
    }
  } catch (err: unknown) {
    const errCode = extractStripeErrorCode(err);
    const errMessage = err instanceof Error ? err.message : String(err);
    const isHardDecline = errCode != null && HARD_DECLINE_CODES.has(errCode);
    console.error(`[AutoTopup] payment failed for ${accountId} (code=${errCode ?? 'unknown'}, hard=${isHardDecline}):`, errMessage);
    await handleFailedCharge(accountId, previousFailures, errCode ?? errMessage.slice(0, 200), isHardDecline);
  }
}

function extractStripeErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; decline_code?: unknown; raw?: { code?: unknown; decline_code?: unknown } };
  const direct = typeof e.code === 'string' ? e.code : null;
  const decline = typeof e.decline_code === 'string' ? e.decline_code : null;
  const rawCode = typeof e.raw?.code === 'string' ? e.raw.code : null;
  const rawDecline = typeof e.raw?.decline_code === 'string' ? e.raw.decline_code : null;
  return decline ?? rawDecline ?? direct ?? rawCode;
}

async function handleFailedCharge(
  accountId: string,
  previousFailures: number,
  reason: string,
  hardDecline: boolean,
): Promise<void> {
  const nextFailures = previousFailures + 1;
  const shouldDisable = hardDecline || nextFailures >= AUTO_TOPUP_MAX_CONSECUTIVE_FAILURES;
  const update: Record<string, unknown> = {
    autoTopupLastCharged: new Date().toISOString(),
    autoTopupConsecutiveFailures: nextFailures,
    autoTopupDisabledReason: reason,
  };
  if (shouldDisable) {
    update.autoTopupEnabled = false;
    console.warn(
      `[AutoTopup] disabling auto-topup for ${accountId} after ` +
      `${hardDecline ? 'hard decline' : `${nextFailures} consecutive failures`} (reason=${reason}). ` +
      `User must re-enable manually after fixing payment method.`,
    );
  }
  await updateCreditAccount(accountId, update as any);
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
