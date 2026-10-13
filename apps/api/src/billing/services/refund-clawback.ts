import type Stripe from 'stripe';
import { logger } from '../../lib/logger';
import { getStripe } from '../../shared/stripe';
import { wallet } from '../wallet';

// A refund or a lost dispute takes the credit back that the payment bought.
// Without it, a customer buys a pack, spends it, and then refunds the charge or
// files a chargeback: Kortix pays the upstream bill and loses the payment.
//
// Only payments that bought credit map to a wallet amount: a Checkout credit
// pack (mode=payment, metadata.type=credit_purchase) and an auto-topup
// PaymentIntent. A subscription invoice charge is skipped: whether a refunded
// renewal also revokes the plan's monthly credit is a policy question.

interface PaidCredit {
  accountId: string;
  description: string;
}

async function resolvePaidCredit(paymentIntentId: string | null): Promise<PaidCredit | null> {
  if (!paymentIntentId) return null;
  const stripe = getStripe();

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.metadata?.type === 'auto_topup' && paymentIntent.metadata.account_id) {
    return { accountId: paymentIntent.metadata.account_id, description: 'auto-topup' };
  }

  const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  const session = sessions.data[0];
  if (session?.mode === 'payment' && session.metadata?.type === 'credit_purchase' && session.metadata.account_id) {
    return { accountId: session.metadata.account_id, description: 'credit purchase' };
  }
  return null;
}

function paymentIntentId(value: string | Stripe.PaymentIntent | null | undefined): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}

async function clawBack(
  accountId: string,
  dollars: number,
  description: string,
  key: string,
): Promise<void> {
  if (dollars <= 0) return;
  // A negative grant of its own kind: not usage, and not refused by the
  // admission floor, so the balance may go negative.
  const result = await wallet.grant({
    accountId,
    amount: -dollars,
    kind: 'admin_debit',
    description,
    expiring: false,
    key: { event: key },
  });
  logger.info(
    `[Webhook] ${description}: -$${dollars.toFixed(2)} for ${accountId}${result.replayed ? ' (replay)' : ''}`,
  );
}

/** `charge.refunded`: take back the newly refunded part of a credit payment. */
export async function handleChargeRefunded(
  charge: Stripe.Charge,
  previousAttributes?: Partial<Stripe.Charge>,
): Promise<void> {
  const refundedCents = charge.amount_refunded - (previousAttributes?.amount_refunded ?? 0);
  if (!(refundedCents > 0)) return;

  const credit = await resolvePaidCredit(paymentIntentId(charge.payment_intent));
  if (!credit) {
    logger.info(`[Webhook] charge.refunded ${charge.id}: not a credit payment, no clawback`);
    return;
  }
  // The key is the cumulative refunded total, so a redelivered event replays and
  // a later partial refund of the same charge is a new key.
  await clawBack(
    credit.accountId,
    refundedCents / 100,
    `Refund clawback (${credit.description}, charge ${charge.id})`,
    `refund:${charge.id}:${charge.amount_refunded}`,
  );
}

/** `charge.dispute.created`: take back the disputed amount while the dispute is open. */
export async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  const credit = await resolvePaidCredit(paymentIntentId(dispute.payment_intent));
  if (!credit) {
    logger.info(`[Webhook] charge.dispute.created ${dispute.id}: not a credit payment, no clawback`);
    return;
  }
  await clawBack(
    credit.accountId,
    dispute.amount / 100,
    `Dispute clawback (${credit.description}, dispute ${dispute.id})`,
    `dispute:${dispute.id}`,
  );
}

/** `charge.dispute.closed`: give the credit back when Kortix won the dispute. */
export async function handleDisputeClosed(dispute: Stripe.Dispute): Promise<void> {
  if (dispute.status !== 'won') return;
  const credit = await resolvePaidCredit(paymentIntentId(dispute.payment_intent));
  if (!credit) return;
  await wallet.grant({
    accountId: credit.accountId,
    amount: dispute.amount / 100,
    kind: 'admin_grant',
    description: `Dispute won, credit restored (${credit.description}, dispute ${dispute.id})`,
    expiring: false,
    key: { event: `dispute-won:${dispute.id}` },
  });
}
