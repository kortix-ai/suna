/**
 * DB suite: billing of a workspace split off a legacy account (design.md §3.2
 * C6, K4). Real schema, real wallet functions. The clock is passed in, never
 * slept on.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { accounts, creditAccounts, creditLedger } from '@kortix/db';
import { and, eq, inArray, like } from 'drizzle-orm';

import { db } from '../../shared/db';
import { applyStripeSync } from './account-write-owner';
import { resolveAccountBilling } from './billing-cache';
import {
  SplitOffBillingTookMoneyError,
  applySplitOffBilling,
  expireSplitOffComps,
  isPayingAccount,
  previewSplitOffBilling,
  reverseSplitOffBilling,
} from './split-off-billing';
import { getTier } from './tiers';

const FREE_USD = getTier('free').monthlyCredits;
const created: string[] = [];
const DAY = 86_400_000;

async function account(name: string): Promise<string> {
  const id = crypto.randomUUID();
  created.push(id);
  await db.insert(accounts).values({ accountId: id, name });
  return id;
}

/** The wallet row the split copy writes for a new account: Free, 0 credits, no eligibility. */
async function splitTarget(name: string, now: Date): Promise<string> {
  const id = await account(name);
  await db.insert(creditAccounts).values({
    accountId: id,
    tier: 'free',
    billingCycleAnchor: now.toISOString(),
    nextCreditGrant: new Date(now.getTime() + 30 * DAY).toISOString(),
    freeCreditsEligible: false,
  });
  return id;
}

async function row(accountId: string) {
  const [r] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  return r!;
}

async function ledger(accountId: string, keyPrefix: string) {
  return db
    .select({ amount: creditLedger.amount, type: creditLedger.type, expiresAt: creditLedger.expiresAt })
    .from(creditLedger)
    .where(and(eq(creditLedger.accountId, accountId), like(creditLedger.stripeEventId, `${keyPrefix}%`)));
}

afterAll(async () => {
  await db.delete(creditLedger).where(inArray(creditLedger.accountId, created));
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, created));
  await db.delete(accounts).where(inArray(accounts.accountId, created));
});

describe('split-off billing (C6)', () => {
  test('a free source: the split-off goes on Free with eligibility and one Free grant, once per run', async () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const source = await account('Free source');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'free' });
    const target = await splitTarget('Free split-off', now);
    const runId = crypto.randomUUID();

    expect(await isPayingAccount(source)).toBe(false);
    expect(await previewSplitOffBilling(source, now)).toEqual({ kind: 'free', compedUntil: null, credits: FREE_USD * 100 });

    const first = await applySplitOffBilling({ runId, sourceAccountId: source, newAccountId: target }, now);
    const replay = await applySplitOffBilling({ runId, sourceAccountId: source, newAccountId: target }, now);

    expect(first).toEqual({ kind: 'free', grantedCredits: FREE_USD * 100 });
    expect(replay).toEqual(first);
    const after = await row(target);
    expect({ tier: after.tier, eligible: after.freeCreditsEligible, comp: after.compPlanUntil, balance: Number(after.balance) })
      .toEqual({ tier: 'free', eligible: true, comp: null, balance: FREE_USD });
    expect(await ledger(target, 'split_off_grant:')).toHaveLength(1);
  });

  test('a paid source: the keeper plan is comped until its period end, with pro-rated expiring credits', async () => {
    // Anchor on the 1st: the period runs 2026-11-01 → 2026-12-01 (30 days), 20 days remain.
    const now = new Date('2026-11-11T00:00:00Z');
    const source = await account('Paid source');
    await db.insert(creditAccounts).values({
      accountId: source,
      tier: 'credits',
      planMonthlyUsd: '300',
      billingCycleAnchor: '2026-01-01T00:00:00Z',
      stripeSubscriptionId: `sub_test_${crypto.randomUUID()}`,
      stripeSubscriptionStatus: 'active',
    });
    const target = await splitTarget('Comped split-off', now);
    const runId = crypto.randomUUID();

    expect(await isPayingAccount(source)).toBe(true);
    const preview = await previewSplitOffBilling(source, now);
    expect(preview).toEqual({ kind: 'comped', compedUntil: '2026-12-01T00:00:00.000Z', credits: 20_000 });

    const result = await applySplitOffBilling({ runId, sourceAccountId: source, newAccountId: target }, now);
    expect(result).toEqual({ kind: 'comped', tier: 'credits', planMonthlyUsd: 300, compedUntil: '2026-12-01T00:00:00.000Z', grantedCredits: 20_000 });
    // Replayed one day later: same window, no second grant.
    const replay = await applySplitOffBilling({ runId, sourceAccountId: source, newAccountId: target }, new Date(now.getTime() + DAY));
    expect(replay).toMatchObject({ kind: 'comped', compedUntil: '2026-12-01T00:00:00.000Z' });

    const after = await row(target);
    expect({
      tier: after.tier,
      monthly: Number(after.planMonthlyUsd),
      sub: after.stripeSubscriptionId,
      comp: new Date(after.compPlanUntil!).toISOString(),
      eligible: after.freeCreditsEligible,
      balance: Number(after.balance),
    }).toEqual({ tier: 'credits', monthly: 300, sub: null, comp: '2026-12-01T00:00:00.000Z', eligible: false, balance: 200 });
    const grants = await ledger(target, 'split_off_comp:');
    expect(grants).toHaveLength(1);
    expect(new Date(grants[0]!.expiresAt!).toISOString()).toBe('2026-12-01T00:00:00.000Z');

    // The comped plan is a paid plan: managed models come with it.
    const resolved = await resolveAccountBilling(target, { fresh: true });
    expect(resolved.plan.family).toBe('credits');
    expect(resolved.entitlements.managedModels).toBe(true);

    // A provider sync never writes Free over an active comp.
    await applyStripeSync(target, { tier: 'free', planMonthlyUsd: null, paymentStatus: 'active' }, { reason: 'test' });
    expect((await row(target)).tier).toBe('credits');
  });

  test('the comp window is capped at 31 days when the keeper has no billing anchor', async () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const source = await account('Paid source, no anchor');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'credits', planMonthlyUsd: '62' });
    const preview = await previewSplitOffBilling(source, now);
    expect(preview).toEqual({ kind: 'comped', compedUntil: '2026-12-12T00:00:00.000Z', credits: 6_200 });
  });

  test('a source that only bought credits on Free: Free with eligibility, never a comp', async () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const source = await account('Top-up source');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'free', lifetimePurchased: '25' });
    expect(await isPayingAccount(source)).toBe(true);
    expect(await previewSplitOffBilling(source, now)).toMatchObject({ kind: 'free', compedUntil: null });
  });

  test('a stale stripe_subscription_id on Free does not make a source paying', async () => {
    const source = await account('Stale subscription id');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'free', stripeSubscriptionId: `sub_stale_${crypto.randomUUID()}` });
    expect(await isPayingAccount(source)).toBe(false);
  });

  test('a comped split-off does not pay: its own split-off gets Free, never a second comp, until it buys a plan', async () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const source = await account('Paid keeper of a comp');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'credits', planMonthlyUsd: '100', billingCycleAnchor: '2026-10-21T00:00:00Z' });
    const comped = await splitTarget('Comped, pays nothing', now);
    await applySplitOffBilling({ runId: crypto.randomUUID(), sourceAccountId: source, newAccountId: comped }, now);
    expect((await row(comped)).tier).toBe('credits');

    // The comp is a gift: no subscription, no purchase. It is not paying.
    expect(await isPayingAccount(comped)).toBe(false);
    expect(await previewSplitOffBilling(comped, now)).toMatchObject({ kind: 'free', compedUntil: null });
    const next = await splitTarget('Split-off of a comp', now);
    expect(await applySplitOffBilling({ runId: crypto.randomUUID(), sourceAccountId: comped, newAccountId: next }, now))
      .toMatchObject({ kind: 'free' });
    expect((await row(next)).compPlanUntil).toBeNull();

    // A subscription it bought during the comp pays.
    await applyStripeSync(comped, { stripeSubscriptionId: `sub_own_${crypto.randomUUID()}`, stripeSubscriptionStatus: 'active', tier: 'credits', planMonthlyUsd: '50' }, { reason: 'test' });
    expect(await isPayingAccount(comped)).toBe(true);
  });

  test('at the comp end the rotation moves the split-off to Free with eligibility and a Free grant', async () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const source = await account('Paid keeper');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'credits', planMonthlyUsd: '100', billingCycleAnchor: '2026-10-21T00:00:00Z' });
    const target = await splitTarget('Comp ends', now);
    const kept = await splitTarget('Comp ends, own plan', now);
    await applySplitOffBilling({ runId: crypto.randomUUID(), sourceAccountId: source, newAccountId: target }, now);
    await applySplitOffBilling({ runId: crypto.randomUUID(), sourceAccountId: source, newAccountId: kept }, now);
    // `kept` started its own subscription during the comp.
    await applyStripeSync(kept, { stripeSubscriptionId: `sub_own_${crypto.randomUUID()}`, stripeSubscriptionStatus: 'active', tier: 'credits', planMonthlyUsd: '50' }, { reason: 'test' });

    const before = await expireSplitOffComps(new Date('2026-11-20T23:59:59Z'));
    expect(before.ended).not.toContain(target);

    const end = new Date('2026-11-21T00:00:01Z');
    const result = await expireSplitOffComps(end);
    expect(result.ended).toContain(target);
    expect(result.kept).toContain(kept);
    // A second tick changes nothing.
    const again = await expireSplitOffComps(end);
    expect(again.ended).not.toContain(target);

    const moved = await row(target);
    expect({ tier: moved.tier, comp: moved.compPlanUntil, eligible: moved.freeCreditsEligible, monthly: moved.planMonthlyUsd, balance: Number(moved.balance) })
      .toEqual({ tier: 'free', comp: null, eligible: true, monthly: null, balance: FREE_USD });
    expect(new Date(moved.nextCreditGrant!).getTime()).toBeGreaterThan(end.getTime());

    const own = await row(kept);
    expect({ tier: own.tier, comp: own.compPlanUntil, monthly: Number(own.planMonthlyUsd) }).toEqual({ tier: 'credits', comp: null, monthly: 50 });
  });

  test('reverse clears the comp and forfeits the split-off credits; it refuses an account that took money', async () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const source = await account('Paid source to reverse');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'credits', planMonthlyUsd: '100', billingCycleAnchor: '2026-10-21T00:00:00Z' });
    const target = await splitTarget('Reversed split-off', now);
    const runId = crypto.randomUUID();
    await applySplitOffBilling({ runId, sourceAccountId: source, newAccountId: target }, now);

    await reverseSplitOffBilling({ runId, newAccountId: target });
    await reverseSplitOffBilling({ runId, newAccountId: target });
    const after = await row(target);
    expect({ tier: after.tier, comp: after.compPlanUntil, eligible: after.freeCreditsEligible, balance: Number(after.balance), monthly: after.planMonthlyUsd })
      .toEqual({ tier: 'free', comp: null, eligible: false, balance: 0, monthly: null });

    const paid = await splitTarget('Split-off that bought credits', now);
    await applySplitOffBilling({ runId: crypto.randomUUID(), sourceAccountId: source, newAccountId: paid }, now);
    await db.update(creditAccounts).set({ lifetimePurchased: '10' }).where(eq(creditAccounts.accountId, paid));
    await expect(reverseSplitOffBilling({ runId: crypto.randomUUID(), newAccountId: paid })).rejects.toBeInstanceOf(SplitOffBillingTookMoneyError);
    expect((await row(paid)).compPlanUntil).not.toBeNull();
  });
  test('a RevenueCat (mobile) subscription bought during the comp keeps its plan at the comp end and refuses the reverse', async () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const source = await account('Paid keeper, mobile split-off');
    await db.insert(creditAccounts).values({ accountId: source, tier: 'credits', planMonthlyUsd: '50', billingCycleAnchor: '2026-10-21T00:00:00Z' });
    const target = await splitTarget('Comp, then a mobile plan', now);
    const runId = crypto.randomUUID();
    await applySplitOffBilling({ runId, sourceAccountId: source, newAccountId: target }, now);
    // The RevenueCat webhook writes the plan through applyStripeSync.
    await applyStripeSync(target, { tier: 'credits', planMonthlyUsd: '20', provider: 'revenuecat', revenuecatSubscriptionId: `rc_syn_${crypto.randomUUID()}` }, { reason: 'test' });
    await db.update(creditAccounts).set({ balance: '25' }).where(eq(creditAccounts.accountId, target));

    await expect(reverseSplitOffBilling({ runId, newAccountId: target })).rejects.toBeInstanceOf(SplitOffBillingTookMoneyError);

    const result = await expireSplitOffComps(new Date('2026-11-21T00:00:01Z'));
    expect(result.kept).toContain(target);
    const own = await row(target);
    expect({ tier: own.tier, comp: own.compPlanUntil, monthly: Number(own.planMonthlyUsd), balance: Number(own.balance) })
      .toEqual({ tier: 'credits', comp: null, monthly: 20, balance: 25 });
  });
});
