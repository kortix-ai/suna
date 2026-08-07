// Admin-issued trial lifecycle: grant, revoke, expiry sweep.
//
// Resolution semantics live in effective-tier.ts (the trial is a lazy overlay,
// never a `tier` write). This module owns the WRITES: the admin routes call
// grantTrial/revokeTrial, the billing cron calls sweepExpiredTrials, and the
// Stripe webhook flips an active trial to 'converted' when a real subscription
// lands (webhooks.ts) so a purchased plan is never masked by the overlay.

import { creditAccounts } from '@kortix/db';
import { and, eq, lte } from 'drizzle-orm';
import { db } from '../../shared/db';
import { clearAccountLimitCache } from '../../shared/account-limits';
import { getCreditAccount, upsertCreditAccount } from '../repositories/credit-accounts';
import { TRIAL_STATUS } from './effective-tier';
import { grantCredits } from './credits';
import { invalidateCachedAccountTier } from './entitlements';
import { isValidTier, MAX_SEATS_PER_ACCOUNT } from './tiers';

export const MAX_TRIAL_DURATION_DAYS = 365;

/** Ledger type for credits granted as part of a trial (reporting cleanliness). */
export const TRIAL_GRANT_LEDGER_TYPE = 'trial_grant';

export type GrantTrialInput = {
  accountId: string;
  /** Existing tier key the trial emulates (e.g. 'team' for BYOK, 'pro'/'enterprise'). */
  tierKey: string;
  seats: number;
  durationDays: number;
  note?: string | null;
  actorUserId?: string | null;
  /**
   * Optional wallet grant, same unit as grantCredits (USD credits: the free
   * welcome grant is `2`, one per-seat month is `25`). Sandbox compute always
   * debits the wallet — even a BYOK trial needs compute credits to run
   * sessions — so the grant is part of the trial issue, explicit and audited,
   * never an implicit wallet-floor bypass.
   */
  creditGrant?: number;
};

export type TrialSnapshot = {
  status: string;
  tier: string | null;
  seats: number | null;
  startedAt: string | null;
  endsAt: string | null;
  note: string | null;
};

export function validateGrantTrialInput(
  input: Pick<GrantTrialInput, 'tierKey' | 'seats' | 'durationDays' | 'creditGrant'>,
): string | null {
  if (!isValidTier(input.tierKey) || input.tierKey === 'none' || input.tierKey === 'free') {
    return `tier_key must be an existing paid tier, got "${input.tierKey}"`;
  }
  if (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > MAX_SEATS_PER_ACCOUNT) {
    return `seats must be an integer in [1, ${MAX_SEATS_PER_ACCOUNT}]`;
  }
  if (
    !Number.isInteger(input.durationDays) ||
    input.durationDays < 1 ||
    input.durationDays > MAX_TRIAL_DURATION_DAYS
  ) {
    return `duration_days must be an integer in [1, ${MAX_TRIAL_DURATION_DAYS}]`;
  }
  if (input.creditGrant !== undefined) {
    if (!Number.isFinite(input.creditGrant) || input.creditGrant < 0 || input.creditGrant > 10_000) {
      return 'credit_grant must be a number in [0, 10000]';
    }
  }
  return null;
}

function trialSnapshotFromRow(
  row: Awaited<ReturnType<typeof getCreditAccount>>,
): TrialSnapshot {
  return {
    status: row?.trialStatus ?? TRIAL_STATUS.NONE,
    tier: row?.trialTier ?? null,
    seats: row?.trialSeats ?? null,
    startedAt: row?.trialStartedAt ?? null,
    endsAt: row?.trialEndsAt ?? null,
    note: row?.trialNote ?? null,
  };
}

function invalidateEntitlementCaches(accountId: string) {
  // Two caches, two clears — the gateway tier-snapshot cache AND the limit
  // cache. Clearing only one is the exact skew the admin tier route shipped
  // with (it cleared limits but not the gateway cache).
  invalidateCachedAccountTier(accountId);
  clearAccountLimitCache();
}

/**
 * Grant (or replace) a trial. Upserts the credit row so a brand-new account
 * can be granted before its first billing event. Re-granting over an existing
 * trial is allowed — it overwrites the window (extend/adjust = re-grant).
 */
export async function grantTrial(input: GrantTrialInput): Promise<{
  before: TrialSnapshot;
  current: TrialSnapshot;
  creditGranted: number;
}> {
  const invalid = validateGrantTrialInput(input);
  if (invalid) throw new Error(invalid);

  const before = trialSnapshotFromRow(await getCreditAccount(input.accountId));
  const now = new Date();
  const endsAt = new Date(now.getTime() + input.durationDays * 24 * 60 * 60 * 1000);

  await upsertCreditAccount(input.accountId, {
    trialStatus: TRIAL_STATUS.ACTIVE,
    trialTier: input.tierKey,
    trialSeats: input.seats,
    trialStartedAt: now.toISOString(),
    trialEndsAt: endsAt.toISOString(),
    trialNote: input.note?.slice(0, 2000) ?? null,
    trialGrantedBy: input.actorUserId ?? null,
  });

  const creditGranted = input.creditGrant ?? 0;
  if (creditGranted > 0) {
    await grantCredits(
      input.accountId,
      creditGranted,
      TRIAL_GRANT_LEDGER_TYPE,
      `Trial grant: ${input.tierKey} tier, ${input.seats} seats, ${input.durationDays} days`,
      false,
    );
  }

  invalidateEntitlementCaches(input.accountId);
  return {
    before,
    current: trialSnapshotFromRow(await getCreditAccount(input.accountId)),
    creditGranted,
  };
}

/**
 * Revoke a trial immediately. Keeps tier/seats/window on the row (audit trail);
 * only the status changes, and `trialIsActive` fails on any non-'active' status.
 */
export async function revokeTrial(accountId: string): Promise<{
  before: TrialSnapshot;
  current: TrialSnapshot;
}> {
  const row = await getCreditAccount(accountId);
  const before = trialSnapshotFromRow(row);
  if (before.status !== TRIAL_STATUS.ACTIVE) {
    throw new Error(`no active trial to revoke (status: ${before.status})`);
  }
  await upsertCreditAccount(accountId, { trialStatus: TRIAL_STATUS.REVOKED });
  invalidateEntitlementCaches(accountId);
  return { before, current: trialSnapshotFromRow(await getCreditAccount(accountId)) };
}

/**
 * Flip rows whose window has passed to 'expired'. Pure hygiene — the lazy
 * check in trialIsActive already stopped granting at the timestamp; this makes
 * the stored status read honestly. Called from the billing cron.
 */
export async function sweepExpiredTrials(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(creditAccounts)
    .set({ trialStatus: TRIAL_STATUS.EXPIRED, updatedAt: now.toISOString() })
    .where(
      and(
        eq(creditAccounts.trialStatus, TRIAL_STATUS.ACTIVE),
        lte(creditAccounts.trialEndsAt, now.toISOString()),
      ),
    )
    .returning({ accountId: creditAccounts.accountId });
  for (const row of rows) invalidateCachedAccountTier(row.accountId);
  if (rows.length > 0) clearAccountLimitCache();
  return rows.length;
}
