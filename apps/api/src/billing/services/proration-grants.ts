/**
 * Wallet grants for PAID mid-period subscription changes.
 *
 * A mid-period change (seats added to a per-seat plan, an upgrade to a larger
 * plan) is billed by a proration invoice (`billing_reason:
 * 'subscription_update'`). The allowance that change buys is granted here, and
 * only from a PAID invoice: a subscription update is a promise to pay, not a
 * payment. The grant is sized by the money the invoice actually settled, so a
 * change made late in the period buys a proportionally smaller grant, and the
 * next renewal resets the wallet to the full allowance as usual.
 *
 * Every grant is keyed on the invoice id (`proration_grant:<invoice id>`), so
 * the synchronous upgrade path and the `invoice.paid` webhook converge on one
 * ledger row.
 */

import type Stripe from 'stripe';
import { getStripe } from '../../shared/stripe';
import { wallet } from '../wallet';
import {
  INCLUDED_CREDITS_RATIO,
  getTier,
  isUpgrade,
  resolvePerSeatPriceId,
  resolveTierForPrice,
} from './tiers';

/** The fields of an invoice line the grant rule reads. */
export interface ProrationLine {
  /** Line amount in cents. Negative for the unused-time credit. */
  amount: number;
  proration: boolean;
  priceId: string | null;
}

export type ProrationGrant =
  | { kind: 'seats'; credits: number; netCents: number }
  | { kind: 'upgrade'; credits: number; netCents: number; fromTier: string; toTier: string }
  | { kind: 'none'; reason: string };

function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * Decide the grant for one paid proration invoice. Pure.
 *
 * - Per-seat: the net amount of the per-seat price's proration lines, times the
 *   included-usage ratio ($25 of every $40 seat dollar). Removing seats
 *   produces a non-positive net and grants nothing.
 * - Plan upgrade: the net proration amount, converted at the target plan's
 *   credits-per-dollar, capped at one month of the target plan's allowance.
 *   A downgrade, or a change between prices that map to no known plan,
 *   grants nothing.
 */
export function computeProrationGrant(
  lines: ProrationLine[],
  options: { perSeatPriceId: string | null },
): ProrationGrant {
  const prorations = lines.filter((line) => line.proration && line.priceId);
  if (prorations.length === 0) return { kind: 'none', reason: 'no proration lines' };

  const seatLines = options.perSeatPriceId
    ? prorations.filter((line) => line.priceId === options.perSeatPriceId)
    : [];
  if (seatLines.length > 0) {
    const netCents = seatLines.reduce((sum, line) => sum + line.amount, 0);
    if (netCents <= 0) return { kind: 'none', reason: 'seat change collected no money' };
    return {
      kind: 'seats',
      netCents,
      credits: roundCents((netCents / 100) * INCLUDED_CREDITS_RATIO),
    };
  }

  const debit = prorations.filter((line) => line.amount > 0).sort((a, b) => b.amount - a.amount)[0];
  const credit = prorations.filter((line) => line.amount < 0).sort((a, b) => a.amount - b.amount)[0];
  if (!debit || !credit) return { kind: 'none', reason: 'not a price change' };

  const toTier = resolveTierForPrice(debit.priceId);
  const fromTier = resolveTierForPrice(credit.priceId);
  if (!toTier || !fromTier) return { kind: 'none', reason: 'price maps to no plan' };
  if (!isUpgrade(fromTier, toTier)) return { kind: 'none', reason: `${fromTier} -> ${toTier} is not an upgrade` };

  const netCents = prorations.reduce((sum, line) => sum + line.amount, 0);
  if (netCents <= 0) return { kind: 'none', reason: 'upgrade collected no money' };

  const target = getTier(toTier);
  if (target.monthlyCredits <= 0 || target.monthlyPrice <= 0) {
    return { kind: 'none', reason: `${toTier} carries no monthly allowance` };
  }
  const credits = Math.min(
    target.monthlyCredits,
    roundCents((netCents / 100) * (target.monthlyCredits / target.monthlyPrice)),
  );
  return { kind: 'upgrade', credits, netCents, fromTier, toTier };
}

async function invoiceLines(invoice: Stripe.Invoice): Promise<ProrationLine[]> {
  let raw: Stripe.InvoiceLineItem[] = invoice.lines?.data ?? [];
  if (invoice.lines?.has_more && invoice.id) {
    raw = await getStripe().invoices.listLineItems(invoice.id, { limit: 100 }).autoPagingToArray({ limit: 1000 });
  }
  return raw.map((line) => ({
    amount: line.amount ?? 0,
    proration: line.proration === true,
    priceId: line.price?.id ?? null,
  }));
}

/**
 * Grant the allowance a PAID proration invoice bought. Returns the decision so
 * callers can log or report it. Throws only when the grant itself fails, which
 * fails the webhook and makes Stripe redeliver it.
 */
export async function grantForPaidProrationInvoice(
  accountId: string,
  invoice: Stripe.Invoice,
): Promise<ProrationGrant> {
  if (invoice.status !== 'paid') {
    return { kind: 'none', reason: `invoice status ${invoice.status ?? 'unknown'}` };
  }

  const decision = computeProrationGrant(await invoiceLines(invoice), {
    perSeatPriceId: resolvePerSeatPriceId(),
  });
  if (decision.kind === 'none' || decision.credits <= 0) {
    console.log(`[proration-grant] ${accountId} invoice ${invoice.id}: no grant (${decision.kind === 'none' ? decision.reason : 'zero credits'})`);
    return decision;
  }

  const paidUsd = (decision.netCents / 100).toFixed(2);
  const description = decision.kind === 'seats'
    ? `Per-seat allowance for added seats: ${decision.credits} credits ($${paidUsd} prorated charge)`
    : `Plan upgrade to ${getTier(decision.toTier).displayName}: ${decision.credits} credits ($${paidUsd} prorated charge)`;

  await wallet.grant({
    accountId,
    amount: decision.credits,
    kind: decision.kind === 'seats' ? 'seat_grant' : 'tier_grant',
    description,
    expiring: true,
    key: { event: `proration_grant:${invoice.id}` },
  });
  console.log(`[proration-grant] ${accountId} invoice ${invoice.id}: ${description}`);
  return decision;
}
