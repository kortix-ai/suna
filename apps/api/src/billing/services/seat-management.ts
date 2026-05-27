// Billing v2 — seat lifecycle orchestration.
//
// One entry point per high-level event: member added, member removed. Each
// orchestrates THREE concerns:
//   1. Per-member YOLO token (mint on add, revoke on remove).
//   2. Stripe subscription quantity sync (count active members, push to Stripe).
//   3. Pro-rated seat credit grant for net additions (handled by the Stripe
//      webhook `customer.subscription.updated` so we don't double-grant).
//
// Hard guard: every call no-ops on legacy accounts. New seat behaviour only
// engages when credit_accounts.billing_model = 'per_seat'.

import { eq, isNull, and } from 'drizzle-orm';
import { accountMembers } from '@kortix/db';
import { db } from '../../shared/db';
import { getStripe } from '../../shared/stripe';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { mintYoloTokenForMember, revokeYoloTokenForMember } from './yolo-tokens';
import { getActiveYoloTokenRow } from '../repositories/yolo-tokens';
import {
  isPerSeatAccount,
  defaultAutoTopupForSeats,
  MAX_SEATS_PER_ACCOUNT,
} from './tiers';

export async function countActiveMembers(accountId: string): Promise<number> {
  const rows = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
  return rows.length;
}

/**
 * Push the current member count to Stripe and reconcile credit_accounts.
 * Stripe's billing engine handles proration on quantity change; the webhook
 * `customer.subscription.updated` is the source of truth for granting credits
 * to net additions.
 *
 * Safe to call repeatedly: if Stripe already has the right quantity, the
 * update is a no-op.
 */
export async function syncSeatQuantity(accountId: string): Promise<{
  synced: boolean;
  seatCount: number;
  skipped?: 'legacy' | 'no-subscription' | 'no-item';
}> {
  const account = await getCreditAccount(accountId);
  if (!isPerSeatAccount(account?.billingModel)) {
    return { synced: false, seatCount: 0, skipped: 'legacy' };
  }
  if (!account?.stripeSubscriptionId) {
    return { synced: false, seatCount: 0, skipped: 'no-subscription' };
  }
  if (!account.seatSubscriptionItemId) {
    return { synced: false, seatCount: 0, skipped: 'no-item' };
  }

  const seatCount = Math.min(MAX_SEATS_PER_ACCOUNT, await countActiveMembers(accountId));

  const stripe = getStripe();
  try {
    await stripe.subscriptionItems.update(account.seatSubscriptionItemId, {
      quantity: seatCount,
      // proration_behavior defaults to 'create_prorations' which is what we
      // want — Stripe creates an invoice line item for the delta on next bill.
    });
  } catch (err) {
    console.error(
      `[seat-management] failed to update Stripe sub item for ${accountId}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  // IMPORTANT: do NOT mirror seat_count locally here. The webhook handler
  // (services/webhooks.ts:syncSubscriptionState) computes the per-seat delta
  // as `newSeats - account.seatCount`. If we wrote seat_count first, the
  // webhook would see delta=0 and skip the seat_grant. Letting the webhook
  // be the sole writer of seat_count keeps the grant logic correct. The UI
  // is briefly stale (≤1s) between the Stripe push and the webhook arriving,
  // which is acceptable.
  //
  // Auto-topup defaults DO scale with seats and don't affect the grant calc,
  // so update those here for immediate consistency.
  if (!account.autoTopupCustomized) {
    const defaults = defaultAutoTopupForSeats(seatCount);
    await updateCreditAccount(accountId, {
      autoTopupThreshold: String(defaults.threshold),
      autoTopupAmount: String(defaults.amount),
    });
  }

  return { synced: true, seatCount };
}

/**
 * Mint a YOLO token for every existing member of an account that doesn't
 * already have one. Called once at per-seat subscription start so the owner
 * (and anyone who joined the account before billing_model='per_seat' flipped)
 * gets a token without having to re-add them.
 *
 * Safe to call repeatedly — only members WITHOUT an active token get one.
 */
export async function mintYoloTokensForAllMembers(accountId: string): Promise<{ minted: number }> {
  const memberRows = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));

  let minted = 0;
  for (const m of memberRows) {
    const existing = await getActiveYoloTokenRow(m.userId, accountId);
    if (existing) continue;
    try {
      await mintYoloTokenForMember(m.userId, accountId);
      minted += 1;
    } catch (err) {
      console.warn(
        `[seat-management] mint YOLO token failed for ${m.userId}@${accountId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { minted };
}

/**
 * Call when a member is added to the account (invite accepted, owner self-
 * insert, SCIM provision, etc.). Mints a per-member YOLO token and bumps the
 * Stripe quantity. Safe to call even if the member already exists.
 */
export async function onMemberAdded(accountId: string, userId: string): Promise<void> {
  const account = await getCreditAccount(accountId);
  if (!isPerSeatAccount(account?.billingModel)) return;

  try {
    await mintYoloTokenForMember(userId, accountId);
  } catch (err) {
    console.warn(
      `[seat-management] mint YOLO token failed for ${userId}@${accountId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await syncSeatQuantity(accountId);
  } catch (err) {
    // Stripe sync failures are not fatal to the member-add flow — the next
    // member change OR a periodic reconciler will catch up. Surface the
    // error in logs so ops can see drift.
    console.warn(
      `[seat-management] seat sync after add failed for ${accountId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Call when a member is removed. Revokes their YOLO token and drops the
 * Stripe quantity by one (Stripe credits the difference on next invoice).
 */
export async function onMemberRemoved(accountId: string, userId: string): Promise<void> {
  const account = await getCreditAccount(accountId);
  if (!isPerSeatAccount(account?.billingModel)) return;

  try {
    await revokeYoloTokenForMember(userId, accountId);
  } catch (err) {
    console.warn(
      `[seat-management] revoke YOLO token failed for ${userId}@${accountId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await syncSeatQuantity(accountId);
  } catch (err) {
    console.warn(
      `[seat-management] seat sync after remove failed for ${accountId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
