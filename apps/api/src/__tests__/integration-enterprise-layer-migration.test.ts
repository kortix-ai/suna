/**
 * Integration test (real local DB): the Enterprise feature-layer data migration
 * (20261015203030267_enterprise_feature_layer) keeps every account's access and
 * every credit: Enterprise trials become the demo, tier='enterprise' becomes a
 * license on the plan the account pays for, and its expiring credits move to
 * the non-expiring bucket so no period reset can wipe them. Each step is
 * guarded, so re-running the file on the migrated database is safe.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { creditAccounts } from '@kortix/db';
import { inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';

const MIGRATION = resolve(
  import.meta.dir,
  '../../../../packages/db/migrations/20261015203030267_enterprise_feature_layer.sql',
);
const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
const [licensedPaying, licensedFree, enterpriseTrial, creditsTrial] = ids as [string, string, string, string];
const inFiveDays = () => new Date(Date.now() + 5 * 86_400_000).toISOString();

async function row(accountId: string) {
  const [r] = await db.select().from(creditAccounts).where(inArray(creditAccounts.accountId, [accountId]));
  return r!;
}

beforeAll(async () => {
  await db.insert(creditAccounts).values([
    {
      accountId: licensedPaying,
      tier: 'enterprise',
      expiringCredits: '15000',
      nonExpiringCredits: '200',
      balance: '15200',
      stripeSubscriptionId: 'sub_live',
      stripeSubscriptionStatus: 'active',
    },
    { accountId: licensedFree, tier: 'enterprise', expiringCredits: '50', balance: '50' },
    { accountId: enterpriseTrial, tier: 'free', trialStatus: 'active', trialTier: 'enterprise', trialEndsAt: inFiveDays() },
    { accountId: creditsTrial, tier: 'credits', trialStatus: 'active', trialTier: 'credits', trialEndsAt: inFiveDays() },
  ]);
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }
}, 20_000);

afterAll(async () => {
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, ids));
});

describe('tier=enterprise becomes a license on the plan the account pays for', () => {
  test('a live Stripe subscription: Credits, licensed, expiring credits moved, balance unchanged', async () => {
    const r = await row(licensedPaying);
    expect([r.tier, r.enterpriseEntitled]).toEqual(['credits', true]);
    expect([Number(r.expiringCredits), Number(r.nonExpiringCredits), Number(r.balance)]).toEqual([0, 15200, 15200]);
  });

  test('no subscription: Free, licensed, credits kept', async () => {
    const r = await row(licensedFree);
    expect([r.tier, r.enterpriseEntitled, Number(r.nonExpiringCredits), Number(r.balance)]).toEqual(['free', true, 50, 50]);
  });
});

describe('trials are removed', () => {
  test('an active Enterprise trial becomes the Enterprise demo', async () => {
    const r = await row(enterpriseTrial);
    expect([r.demoEnterprise, r.trialStatus, r.tier]).toEqual([true, 'expired', 'free']);
  });

  test('an active Credits trial simply ends', async () => {
    const r = await row(creditsTrial);
    expect([r.demoEnterprise, r.trialStatus, r.tier]).toEqual([false, 'expired', 'credits']);
  });
});
