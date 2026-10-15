// Trials: a dated grant of a plan (.agents/skills/billing/references/plans-and-access.md).
//
// Resolution lives in resolve-billing.ts (the trial is a lazy overlay on the
// trial columns, never a `tier` write). This module owns the WRITES: the admin
// routes call grantTrial/revokeTrial, the access sweep calls
// sweepExpiredTrials, and the Stripe webhooks call markTrialConverted when a
// purchase ends a trial.

import { creditAccounts } from '@kortix/db';
import { and, eq, lte } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isoValue } from '../../shared/cost-values';
import { clearAccountLimitCache } from '../../shared/account-limits';
import { getCreditAccount } from '../repositories/credit-accounts';
import { applyAdminOverride } from './account-write-owner';
import { TRIAL_STATUS } from './effective-tier';
import { ENTITLEMENT_OVERRIDE_KEYS, parseEntitlementOverrides, toStoredOverrides } from './entitlement-overrides';
import { invalidateCachedAccountTier } from './entitlements';
import { canonicalTier } from './tiers';
import { wallet } from '../wallet';

export const MAX_TRIAL_DURATION_DAYS = 365;
/** Largest one-time trial credit grant, USD. */
export const MAX_TRIAL_CREDIT_GRANT_USD = 10_000;
/** The default one-time credit grant of an Enterprise trial, USD. */
export const DEFAULT_ENTERPRISE_TRIAL_CREDITS_USD = 500;

/** Ledger type for credits granted as part of a trial (reporting cleanliness). */
export const TRIAL_GRANT_LEDGER_TYPE = 'trial_grant';

export type TrialPlan = 'credits' | 'enterprise';

export type GrantTrialInput = {
  accountId: string;
  /** The plan the trial grants: 'credits' or 'enterprise' (legacy keys resolve). */
  tierKey: string;
  durationDays: number;
  note?: string | null;
  actorUserId?: string | null;
  /**
   * One-time wallet grant in USD, expiring at the trial end. Defaults to
   * DEFAULT_ENTERPRISE_TRIAL_CREDITS_USD for an Enterprise trial and 0 for a
   * Credits trial. Compute always debits the wallet, so a trial with no
   * credits can open the plan's features but not run a session.
   */
  creditGrant?: number;
};

export type TrialSnapshot = {
  status: string;
  tier: string | null;
  startedAt: string | null;
  endsAt: string | null;
  note: string | null;
};

/** The plan a trial grants, or null when the key is not a trial plan. */
export function trialPlanFor(tierKey: string): TrialPlan | null {
  const plan = canonicalTier(tierKey);
  return plan === 'credits' || plan === 'enterprise' ? plan : null;
}

export function validateGrantTrialInput(
  input: Pick<GrantTrialInput, 'tierKey' | 'durationDays' | 'creditGrant'>,
): string | null {
  // Exactly the two plan keys: a retired key ('team', 'tier_2_20') is not a plan
  // to grant, even though a stored one still resolves (trialPlanFor).
  if (input.tierKey !== 'credits' && input.tierKey !== 'enterprise') {
    return `tier_key must be 'credits' or 'enterprise', got "${input.tierKey}"`;
  }
  if (
    !Number.isInteger(input.durationDays) ||
    input.durationDays < 1 ||
    input.durationDays > MAX_TRIAL_DURATION_DAYS
  ) {
    return `duration_days must be an integer in [1, ${MAX_TRIAL_DURATION_DAYS}]`;
  }
  if (input.creditGrant !== undefined) {
    if (!Number.isFinite(input.creditGrant) || input.creditGrant < 0 || input.creditGrant > MAX_TRIAL_CREDIT_GRANT_USD) {
      return `credit_grant must be a number in [0, ${MAX_TRIAL_CREDIT_GRANT_USD}]`;
    }
  }
  return null;
}

function trialSnapshotFromRow(row: Awaited<ReturnType<typeof getCreditAccount>>): TrialSnapshot {
  return {
    status: row?.trialStatus ?? TRIAL_STATUS.NONE,
    tier: row?.trialTier ?? null,
    startedAt: isoValue(row?.trialStartedAt),
    endsAt: isoValue(row?.trialEndsAt),
    note: row?.trialNote ?? null,
  };
}

function invalidateEntitlementCaches(accountId: string) {
  // Two caches, two clears — the gateway tier-snapshot cache AND the limit cache.
  invalidateCachedAccountTier(accountId);
  clearAccountLimitCache();
}

/**
 * The overrides with the copies an older trial grant wrote removed. Before the
 * one-plan model, a trial also wrote its plan's entitlements into
 * `entitlement_overrides`, each expiring at the trial end. Those copies are
 * recognised by that exact `expires_at`, so an operator's own override on the
 * same key survives.
 */
export function withoutTrialCopies(overrides: unknown, trialEndsAt: string | null | undefined) {
  const parsed = parseEntitlementOverrides(overrides);
  if (!trialEndsAt) return parsed;
  const endsMs = new Date(trialEndsAt).getTime();
  for (const key of ENTITLEMENT_OVERRIDE_KEYS) {
    const entry = parsed[key];
    if (entry?.expires_at && new Date(entry.expires_at).getTime() === endsMs) delete parsed[key];
  }
  return parsed;
}

/**
 * Grant (or replace) a trial: "behave as plan X until date Z", with one
 * expiring credit grant. Re-granting moves the end date (extend = re-grant)
 * and grants credits again only when `creditGrant` is above 0.
 *
 * Upserts the credit row so a brand-new account can be granted before its
 * first billing event.
 */
export async function grantTrial(input: GrantTrialInput): Promise<{
  before: TrialSnapshot;
  current: TrialSnapshot;
  creditGranted: number;
}> {
  const invalid = validateGrantTrialInput(input);
  if (invalid) throw new Error(invalid);
  const plan = trialPlanFor(input.tierKey) as TrialPlan;
  const creditGrant = input.creditGrant ?? (plan === 'enterprise' ? DEFAULT_ENTERPRISE_TRIAL_CREDITS_USD : 0);

  const row = await getCreditAccount(input.accountId);
  const before = trialSnapshotFromRow(row);
  const now = new Date();
  const endsAtIso = new Date(now.getTime() + input.durationDays * 24 * 60 * 60 * 1000).toISOString();
  const extending = before.status === TRIAL_STATUS.ACTIVE && before.tier === plan && !!before.startedAt;

  await applyAdminOverride(
    input.accountId,
    {
      trialStatus: TRIAL_STATUS.ACTIVE,
      trialTier: plan,
      trialMonthlyUsd: null,
      trialStartedAt: extending ? before.startedAt : now.toISOString(),
      trialEndsAt: endsAtIso,
      trialNote: input.note?.slice(0, 2000) ?? null,
      trialGrantedBy: input.actorUserId ?? null,
      entitlementOverrides: toStoredOverrides(withoutTrialCopies(row?.entitlementOverrides, before.endsAt)),
    },
    { userId: input.actorUserId ?? null, action: extending ? 'admin.account.trial.extend' : 'admin.account.trial.grant' },
  );

  if (creditGrant > 0) {
    // Expiring with the trial: granted credits are part of the grant and die with it.
    await wallet.grant({
      accountId: input.accountId,
      amount: creditGrant,
      kind: TRIAL_GRANT_LEDGER_TYPE,
      description: `Trial credits: ${plan} plan until ${endsAtIso.slice(0, 10)}`,
      expiring: true,
      expiresAt: endsAtIso,
      key: { request: `trial:${input.accountId}:${now.getTime()}` },
    });
  }

  invalidateEntitlementCaches(input.accountId);
  return {
    before,
    current: trialSnapshotFromRow(await getCreditAccount(input.accountId)),
    creditGranted: creditGrant,
  };
}

/**
 * Revoke a trial immediately. Keeps plan and window on the row (audit trail);
 * only the status changes, and `trialIsActive` fails on any non-'active'
 * status. A revoke gets no SSO grace: it is deliberate.
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
    {
      trialStatus: TRIAL_STATUS.REVOKED,
      entitlementOverrides: toStoredOverrides(withoutTrialCopies(row?.entitlementOverrides, before.endsAt)),
    },
    { action: 'admin.account.trial.revoke' },
  );
  invalidateEntitlementCaches(accountId);
  return { before, current: trialSnapshotFromRow(await getCreditAccount(accountId)) };
}

/**
 * Flip an ACTIVE trial to 'converted' because the account bought the plan.
 *
 * A deliberate cross-domain write: `trial_status` is admin-owned, but the fact
 * that ends it — a purchase — is only observed by the billing-provider webhook.
 * The webhook calls this narrow verb instead of carrying an admin-owned key.
 *
 * `purchased` is the plan that was bought. Buying Credits ends a Credits trial
 * only: an Enterprise trial keeps running to its end, then the account lands
 * on Credits. Accepting an Enterprise contract ends any trial.
 *
 * Self-guarding: it re-reads the row and no-ops unless the trial is still
 * ACTIVE. Returns whether it wrote.
 */
export async function markTrialConverted(accountId: string, purchased: TrialPlan = 'credits'): Promise<boolean> {
  const row = await getCreditAccount(accountId);
  if (row?.trialStatus !== TRIAL_STATUS.ACTIVE) return false;
  if (purchased === 'credits' && trialPlanFor(row.trialTier ?? '') === 'enterprise') return false;

  await applyAdminOverride(
    accountId,
    {
      trialStatus: TRIAL_STATUS.CONVERTED,
      entitlementOverrides: toStoredOverrides(withoutTrialCopies(row.entitlementOverrides, row.trialEndsAt)),
    },
    { action: 'billing.trial.converted' },
  );
  invalidateEntitlementCaches(accountId);
  return true;
}

/**
 * Flip rows whose window has passed to 'expired' and return them, so the
 * caller can tell the account and Kortix. The lazy check in `trialIsActive`
 * already stopped granting at the timestamp; this makes the stored status read
 * honestly and is the moment the "trial ended" notice goes out.
 */
export async function sweepExpiredTrials(
  now: Date = new Date(),
): Promise<Array<{ accountId: string; trialTier: string | null; trialEndsAt: string | null }>> {
  const rows = await db
    .update(creditAccounts)
    .set({ trialStatus: TRIAL_STATUS.EXPIRED, updatedAt: now.toISOString() })
    .where(
      and(
        eq(creditAccounts.trialStatus, TRIAL_STATUS.ACTIVE),
        lte(creditAccounts.trialEndsAt, now.toISOString()),
      ),
    )
    .returning({
      accountId: creditAccounts.accountId,
      trialTier: creditAccounts.trialTier,
      trialEndsAt: creditAccounts.trialEndsAt,
    });
  for (const row of rows) invalidateCachedAccountTier(row.accountId);
  if (rows.length > 0) clearAccountLimitCache();
  return rows;
}
