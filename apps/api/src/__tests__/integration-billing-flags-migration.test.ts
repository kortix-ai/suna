/**
 * Integration test (real local DB): the one-plan data migration
 * (20261015003246450_billing_admins_trials_from_demo) carries every retired
 * flag over without changing what an account can do. The test re-runs the
 * migration file on synthetic rows; each step is guarded, so a second run is
 * safe on the already-migrated database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { creditAccounts, enterpriseContracts } from '@kortix/db';
import { inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';

const MIGRATION = resolve(
  import.meta.dir,
  '../../../../packages/db/migrations/20261015003246450_billing_admins_trials_from_demo.sql',
);
const ids = Array.from({ length: 7 }, () => crypto.randomUUID());
const [column, jsonbExpiring, jsonbFalse, jsonbExpired, enterprise, modelsColumn, demo] = ids as [
  string, string, string, string, string, string, string,
];
const FUTURE = '2099-01-01T00:00:00Z';

async function overrides(accountId: string) {
  const [row] = await db
    .select({ o: creditAccounts.entitlementOverrides })
    .from(creditAccounts)
    .where(inArray(creditAccounts.accountId, [accountId]));
  return row!.o as Record<string, { value: boolean; expires_at?: string }>;
}

beforeAll(async () => {
  await db.insert(creditAccounts).values([
    { accountId: column, tier: 'credits', enterpriseEntitled: true },
    { accountId: jsonbExpiring, tier: 'free', entitlementOverrides: { enterpriseEntitled: { value: true, expires_at: FUTURE } } },
    { accountId: jsonbFalse, tier: 'free', enterpriseEntitled: true, entitlementOverrides: { enterpriseEntitled: { value: false } } },
    {
      accountId: jsonbExpired,
      tier: 'credits',
      enterpriseEntitled: true,
      entitlementOverrides: { enterpriseEntitled: { value: true, expires_at: '2020-01-01T00:00:00Z' }, sso: { value: false } },
    },
    {
      accountId: enterprise,
      tier: 'enterprise',
      enterpriseEntitled: true,
      managedModelsOverride: false,
      entitlementOverrides: { managedModelsOverride: { value: true, expires_at: FUTURE } },
    },
    { accountId: modelsColumn, tier: 'credits', managedModelsOverride: true },
    { accountId: demo, tier: 'free', demoEnterprise: true },
  ]);
  const statements = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint');
  for (const statement of statements) await db.execute(sql.raw(statement));
}, 20_000);

afterAll(async () => {
  await db.delete(enterpriseContracts).where(inArray(enterpriseContracts.accountId, ids));
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, ids));
});

const FIVE = ['sso', 'scim', 'rbac', 'auditAccess', 'branding'];

describe('enterprise_entitled becomes the five per-key overrides it granted', () => {
  test('the column flag: five permanent overrides', async () => {
    const o = await overrides(column);
    for (const key of FIVE) expect(o[key]).toEqual({ value: true });
  });

  test('an unexpired JSONB flag: five overrides with its expiry', async () => {
    const o = await overrides(jsonbExpiring);
    for (const key of FIVE) expect(o[key]).toEqual({ value: true, expires_at: FUTURE });
  });

  test('a JSONB false wins over the column: nothing granted', async () => {
    const o = await overrides(jsonbFalse);
    for (const key of FIVE) expect(o[key]).toBeUndefined();
  });

  test('an expired JSONB flag falls back to the column; an existing override is kept', async () => {
    const o = await overrides(jsonbExpired);
    expect(o.sso).toEqual({ value: false });
    for (const key of FIVE.filter((k) => k !== 'sso')) expect(o[key]).toEqual({ value: true });
  });

  test('an Enterprise-plan account gets a contract record, not overrides', async () => {
    const o = await overrides(enterprise);
    for (const key of FIVE) expect(o[key]).toBeUndefined();
    const contracts = await db
      .select({ status: enterpriseContracts.status })
      .from(enterpriseContracts)
      .where(inArray(enterpriseContracts.accountId, [enterprise]));
    expect(contracts).toEqual([{ status: 'active' }]);
  });
});

describe('managed models move to the managedModels key', () => {
  test('the JSONB entry wins over the column and keeps its expiry', async () => {
    expect((await overrides(enterprise)).managedModels).toEqual({ value: true, expires_at: FUTURE });
  });

  test('the column alone becomes a permanent entry', async () => {
    expect((await overrides(modelsColumn)).managedModels).toEqual({ value: true });
  });
});

test('the Enterprise preview becomes a 14-day Enterprise trial', async () => {
  const [row] = await db.select().from(creditAccounts).where(inArray(creditAccounts.accountId, [demo]));
  expect(row!.trialStatus).toBe('active');
  expect(row!.trialTier).toBe('enterprise');
  const days = (new Date(row!.trialEndsAt!).getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(13.9);
  expect(days).toBeLessThanOrEqual(14);
});
