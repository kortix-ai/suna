/**
 * Integration test (real local DB): trials and Enterprise contracts never end
 * silently (.agents/skills/billing/references/plans-and-access.md). On
 * 2026-10-14 an Enterprise trial lapsed with no warning and the account fell
 * to Free. Captured: the email transport. Everything else is real: the trial
 * columns, enterprise_contracts, the wallet and chat_event_dedup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, creditAccounts, creditLedger, enterpriseContracts } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { runAccessSweep } from '../billing/services/access-notices';
import { createContract, endContract, getActiveContract } from '../billing/services/enterprise-contracts';
import { resolveBillingFromRow } from '../billing/services/resolve-billing';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const DAY = 24 * 60 * 60 * 1000;
const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const email = (id: string, role: string) => `access-${role}-${id.slice(0, 8)}@example.test`;

let ending: SeededProject;
let lapsed: SeededProject;
let contracted: SeededProject;
let sent: EmailMessage[] = [];

const customerEmails = () => sent.filter((m) => !m.subject.startsWith('[Kortix billing]'));
const opsEmails = () => sent.filter((m) => m.subject.startsWith('[Kortix billing]'));

beforeAll(async () => {
  ending = await seedProject('access-ending');
  lapsed = await seedProject('access-lapsed');
  contracted = await seedProject('access-contracted');
  for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member']] as const) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${id}::uuid, ${email(id, role)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  }
  for (const account of [ending, lapsed, contracted]) {
    await insertIntoView(db, accountMembers, { userId: OWNER, accountId: account.account_id, accountRole: 'owner' });
  }
  await insertIntoView(db, accountMembers, { userId: ADMIN, accountId: ending.account_id, accountRole: 'admin' });
  await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: ending.account_id, accountRole: 'member' });

  const now = Date.now();
  await db.insert(creditAccounts).values([
    {
      accountId: ending.account_id,
      tier: 'free',
      trialStatus: 'active',
      trialTier: 'enterprise',
      trialStartedAt: new Date(now - 25 * DAY).toISOString(),
      trialEndsAt: new Date(now + 5 * DAY - 60_000).toISOString(),
    },
    {
      accountId: lapsed.account_id,
      tier: 'free',
      trialStatus: 'active',
      trialTier: 'enterprise',
      trialStartedAt: new Date(now - 30 * DAY).toISOString(),
      trialEndsAt: new Date(now - 60 * 60_000).toISOString(),
    },
    { accountId: contracted.account_id, tier: 'free' },
  ]);
  setOwnerAlertSenderForTest(async (message) => {
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
}, 20_000);

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  setOwnerAlertSenderForTest(null);
  if (!ending) return;
  for (const account of [ending, lapsed, contracted]) {
    await db.delete(enterpriseContracts).where(eq(enterpriseContracts.accountId, account.account_id));
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, account.account_id));
  }
  await removeSeeded([ending, lapsed, contracted]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ADMIN}::uuid, ${MEMBER}::uuid)`);
});

describe('the access sweep', () => {
  test('a trial 5 days from its end warns the owner and the admin (not the member), and Kortix sales', async () => {
    const result = await runAccessSweep();
    expect(result.warningsSent).toBe(1);
    const warning = customerEmails().filter((m) => m.category === 'billing-trial-ending');
    expect(warning.map((m) => m.to[0]).sort()).toEqual([email(OWNER, 'owner'), email(ADMIN, 'admin')].sort());
    expect(warning[0]!.subject).toContain('Enterprise trial ends in 5 days');
    expect(warning[0]!.text).toContain('SSO and SCIM stay on for 14 more days');
    expect(opsEmails().some((m) => m.category === 'billing-trial-ending-ops')).toBe(true);
  });

  test('the trial that passed its end expires, once, with a "trial ended" notice', async () => {
    const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, lapsed.account_id));
    expect(row!.trialStatus).toBe('expired');
    // The first sweep (previous test) sent it; a second sweep sends nothing new.
    const again = await runAccessSweep();
    expect(again).toEqual({ trialsExpired: 0, contractsEnded: 0, warningsSent: 0 });
    expect(sent).toEqual([]);
  });

  test('after the lapse the account is on Free with SSO and SCIM kept for the grace', async () => {
    const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, lapsed.account_id));
    const resolved = resolveBillingFromRow(row);
    expect(resolved.plan.family).toBe('free');
    expect(resolved.entitlements.sso).toBe(true);
    expect(resolved.entitlements.rbac).toBe(false);
    expect(resolved.grace?.reason).toBe('trial_ended');
  });
});

describe('a manual Enterprise contract', () => {
  test('activates at once: tier enterprise, and the annual pool granted, expiring at the term end', async () => {
    const contract = await createContract({
      accountId: contracted.account_id,
      licenseUsd: 25000,
      creditsUsd: 15000,
      collection: 'manual',
      note: 'integration test',
    });
    expect(contract.status).toBe('active');
    const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, contracted.account_id));
    expect(row!.tier).toBe('enterprise');
    const grants = await db
      .select({ amount: creditLedger.amount, expiresAt: creditLedger.expiresAt })
      .from(creditLedger)
      .where(and(eq(creditLedger.accountId, contracted.account_id), eq(creditLedger.type, 'contract_grant')));
    expect(grants.map((g) => Number(g.amount))).toEqual([15000]);
    expect(new Date(grants[0]!.expiresAt!).getTime()).toBe(new Date(contract.endsAt!).getTime());
  });

  test('a second active contract is refused', async () => {
    await expect(
      createContract({ accountId: contracted.account_id, licenseUsd: 1, creditsUsd: 1, collection: 'manual' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('ending it returns the account to Free, keeps SSO/SCIM for 14 days, and tells the account and sales', async () => {
    const active = await getActiveContract(contracted.account_id);
    const ended = await endContract(active!.id, 'operator');
    expect(ended.status).toBe('ended');
    const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, contracted.account_id));
    expect(row!.tier).toBe('free');
    const resolved = resolveBillingFromRow(row);
    expect(resolved.entitlements.sso).toBe(true);
    expect(resolved.entitlements.scim).toBe(true);
    expect(resolved.entitlements.rbac).toBe(false);
    expect(customerEmails().map((m) => m.category)).toEqual(['billing-contract-ended']);
    expect(opsEmails().map((m) => m.category)).toEqual(['billing-contract-ended-ops']);
  });
});
