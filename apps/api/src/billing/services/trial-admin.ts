// Admin-issued trial lifecycle: grant, revoke, expiry sweep.
//
// Resolution semantics live in effective-tier.ts (the trial is a lazy overlay,
// never a `tier` write). This module owns the WRITES: the admin routes call
// grantTrial/revokeTrial, the billing cron calls sweepExpiredTrials, and the
// Stripe webhook flips an active trial to 'converted' when a real subscription
// lands (webhooks.ts) so a purchased plan is never masked by the overlay.

import { creditAccounts, creditLedger } from '@kortix/db';
import { and, eq, gt, lte } from 'drizzle-orm';
import { db } from '../../shared/db';
import { clearAccountLimitCache } from '../../shared/account-limits';
import { getCreditAccount } from '../repositories/credit-accounts';
import { applyAdminOverride } from './account-write-owner';
import { TRIAL_STATUS } from './effective-tier';
import { grantCredits } from './credits';
import { invalidateCachedAccountTier } from './entitlements';
import { grantForSeats, isValidTier, MAX_SEATS_PER_ACCOUNT } from './tiers';

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

  await applyAdminOverride(
    input.accountId,
    {
      trialStatus: TRIAL_STATUS.ACTIVE,
      trialTier: input.tierKey,
      trialSeats: input.seats,
      trialStartedAt: now.toISOString(),
      trialEndsAt: endsAt.toISOString(),
      trialNote: input.note?.slice(0, 2000) ?? null,
      trialGrantedBy: input.actorUserId ?? null,
    },
    { userId: input.actorUserId ?? null, action: 'admin.account.trial.grant' },
  );

  const creditGranted = input.creditGrant ?? 0;
  if (creditGranted > 0) {
    // Expiring, stamped with the trial window's end: trial credits are part of
    // the trial, they die with it. (They previously landed as PERMANENT
    // credits — a trial that ended left real spendable money behind.)
    await grantCredits(
      input.accountId,
      creditGranted,
      TRIAL_GRANT_LEDGER_TYPE,
      `Trial grant: ${input.tierKey} tier, ${input.seats} seats, ${input.durationDays} days`,
      true,
      undefined,
      { expiresAt: endsAt.toISOString() },
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
  await applyAdminOverride(
    accountId,
    { trialStatus: TRIAL_STATUS.REVOKED },
    { action: 'admin.account.trial.revoke' },
  );
  invalidateEntitlementCaches(accountId);
  return { before, current: trialSnapshotFromRow(await getCreditAccount(accountId)) };
}

/**
 * Flip an ACTIVE trial to 'converted' because a real subscription landed.
 *
 * A deliberate cross-domain write, and the only one in the file: `trial_status`
 * is admin-owned (an operator issues the trial), but the FACT that ends it —
 * a paying subscription — is only ever observed by the billing-provider
 * webhook. Rather than let `applyStripeSync` carry an admin-owned key (it
 * throws on one, on purpose), the webhook calls this narrow verb, which writes
 * exactly one field and nothing else.
 *
 * Self-guarding: it re-reads the row and no-ops unless the trial is still
 * ACTIVE, so a redelivered webhook cannot turn 'none'/'expired'/'revoked' into
 * 'converted'. Returns whether it wrote.
 */
export async function markTrialConverted(accountId: string): Promise<boolean> {
  const row = await getCreditAccount(accountId);
  if (row?.trialStatus !== TRIAL_STATUS.ACTIVE) return false;

  await applyAdminOverride(
    accountId,
    { trialStatus: TRIAL_STATUS.CONVERTED },
    { action: 'billing.trial.converted' },
  );
  invalidateEntitlementCaches(accountId);
  return true;
}

const MS_PER_TRIAL_MONTH = 30 * 24 * 60 * 60 * 1000;

/**
 * Pure plan for a trial's monthly re-grant at `now`. Returns null when no
 * re-grant is due: still inside month 1, or the window has ended. Month 1 is
 * covered by the issue-time `creditGrant`; this covers months 2..N. One stable
 * idempotency key per (account, trial start, month index).
 */
export function trialMonthlyRegrant(
  trial: {
    accountId: string;
    startedAt: string | null;
    endsAt: string | null;
    seats: number | null;
  },
  now: Date,
): { monthIndex: number; amount: number; idempotencyKey: string } | null {
  if (!trial.startedAt || !trial.endsAt) return null;
  const startedMs = new Date(trial.startedAt).getTime();
  const endsMs = new Date(trial.endsAt).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(endsMs)) return null;
  if (now.getTime() >= endsMs) return null;

  const monthIndex = Math.floor((now.getTime() - startedMs) / MS_PER_TRIAL_MONTH);
  if (monthIndex < 1) return null;

  const seats = Math.max(1, trial.seats ?? 1);
  const amount = grantForSeats(seats);
  if (amount <= 0) return null;

  return {
    monthIndex,
    amount,
    idempotencyKey: `trial_regrant_${trial.accountId}_${startedMs}_${monthIndex}`,
  };
}

/**
 * Monthly credit re-grant for active trials. A trial's credit entitlement is
 * per-seat per-month (`grantForSeats`, $25/seat) — the issue-time `creditGrant`
 * covers month 1, and this sweep grants each subsequent 30-day boundary inside
 * the trial window. Idempotent across runs: one ledger row per
 * (account, trial start, month index), checked against the ledger directly
 * because the RPC's own idempotency window is only 1 hour.
 * Called from the billing cron alongside sweepExpiredTrials.
 */
export async function sweepTrialMonthlyGrants(now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const rows = await db
    .select({
      accountId: creditAccounts.accountId,
      trialTier: creditAccounts.trialTier,
      trialSeats: creditAccounts.trialSeats,
      trialStartedAt: creditAccounts.trialStartedAt,
      trialEndsAt: creditAccounts.trialEndsAt,
    })
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.trialStatus, TRIAL_STATUS.ACTIVE),
        gt(creditAccounts.trialEndsAt, nowIso),
        lte(creditAccounts.trialStartedAt, new Date(now.getTime() - MS_PER_TRIAL_MONTH).toISOString()),
      ),
    );

  let granted = 0;
  for (const row of rows) {
    const plan = trialMonthlyRegrant(
      {
        accountId: row.accountId,
        startedAt: row.trialStartedAt,
        endsAt: row.trialEndsAt,
        seats: row.trialSeats,
      },
      now,
    );
    if (!plan) continue;

    const existing = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, plan.idempotencyKey))
      .limit(1);
    if (existing.length > 0) continue;

    const seats = Math.max(1, row.trialSeats ?? 1);
    await grantCredits(
      row.accountId,
      plan.amount,
      TRIAL_GRANT_LEDGER_TYPE,
      `Trial monthly re-grant: month ${plan.monthIndex + 1}, ${seats} seats (${row.trialTier ?? 'trial'})`,
      true,
      undefined,
      { expiresAt: row.trialEndsAt, idempotencyKey: plan.idempotencyKey },
    );
    granted++;
  }
  return granted;
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
