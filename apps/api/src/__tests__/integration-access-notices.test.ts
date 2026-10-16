/**
 * Integration test (real local DB): an Enterprise license never ends silently
 * and never touches money (.agents/skills/billing/references/plans-and-access.md).
 * Captured: the email transport. Everything else is real: credit_accounts,
 * enterprise_contracts, the wallet and chat_event_dedup.
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
let licensed: SeededProject;
let sent: EmailMessage[] = [];

const customerEmails = () => sent.filter((m) => !m.subject.startsWith('[Kortix billing]'));
const opsEmails = () => sent.filter((m) => m.subject.startsWith('[Kortix billing]'));

beforeAll(async () => {
  ending = await seedProject('access-ending');
  licensed = await seedProject('access-licensed');
  for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member']] as const) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${id}::uuid, ${email(id, role)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  }
  for (const account of [ending, licensed]) {
    await insertIntoView(db, accountMembers, { userId: OWNER, accountId: account.account_id, accountRole: 'owner' });
  }
  await insertIntoView(db, accountMembers, { userId: ADMIN, accountId: ending.account_id, accountRole: 'admin' });
  await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: ending.account_id, accountRole: 'member' });
  await db.insert(creditAccounts).values([
    { accountId: ending.account_id, tier: 'free' },
    { accountId: licensed.account_id, tier: 'credits', balance: '40', nonExpiringCredits: '40' },
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
  for (const account of [ending, licensed]) {
    await db.delete(enterpriseContracts).where(eq(enterpriseContracts.accountId, account.account_id));
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, account.account_id));
  }
  await removeSeeded([ending, licensed]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ADMIN}::uuid, ${MEMBER}::uuid)`);
});

describe('the access sweep', () => {
  test('a license 5 days from a non-renewing end warns the owner and the admin (not the member), and Kortix sales', async () => {
    await createContract({ accountId: ending.account_id, licenseUsd: 25000, collection: 'manual', termMonths: 12 });
    await db
      .update(enterpriseContracts)
      .set({ endsAt: new Date(Date.now() + 5 * DAY - 60_000).toISOString() })
      .where(eq(enterpriseContracts.accountId, ending.account_id));
    const result = await runAccessSweep();
    expect(result.warningsSent).toBe(1);
    const warning = customerEmails().filter((m) => m.category === 'billing-contract-ending');
    expect(warning.map((m) => m.to[0]).sort()).toEqual([email(OWNER, 'owner'), email(ADMIN, 'admin')].sort());
    expect(warning[0]!.subject).toContain('Enterprise license ends in 5 days');
    expect(opsEmails().some((m) => m.category === 'billing-contract-ending-ops')).toBe(true);
  });

  test('a second sweep sends nothing new', async () => {
    expect(await runAccessSweep()).toEqual({ contractsEnded: 0, warningsSent: 0 });
    expect(sent).toEqual([]);
  });
});

describe('a manual Enterprise license', () => {
  test('activates at once: Licensed, the billing plan and the wallet untouched', async () => {
    const contract = await createContract({
      accountId: licensed.account_id,
      licenseUsd: 25000,
      creditsUsd: 15000,
      collection: 'manual',
      note: 'integration test',
    });
    expect(contract.status).toBe('active');
    expect(Number(contract.creditsUsd)).toBe(0);
    const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, licensed.account_id));
    expect([row!.tier, row!.enterpriseEntitled, Number(row!.balance)]).toEqual(['credits', true, 40]);
    expect(resolveBillingFromRow(row).enterprise).toBe('licensed');
    const grants = await db
      .select({ amount: creditLedger.amount })
      .from(creditLedger)
      .where(and(eq(creditLedger.accountId, licensed.account_id), eq(creditLedger.type, 'contract_grant')));
    expect(grants).toEqual([]);
  });

  test('a second active license is refused', async () => {
    await expect(
      createContract({ accountId: licensed.account_id, licenseUsd: 1, collection: 'manual' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('ending it turns Enterprise off, keeps SSO/SCIM for 14 days, keeps the plan, and tells the account and sales', async () => {
    const active = await getActiveContract(licensed.account_id);
    const ended = await endContract(active!.id, 'operator');
    expect(ended.status).toBe('ended');
    const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, licensed.account_id));
    expect([row!.tier, row!.enterpriseEntitled]).toEqual(['credits', false]);
    const resolved = resolveBillingFromRow(row);
    expect(resolved.enterprise).toBe('off');
    expect(resolved.entitlements.sso).toBe(true);
    expect(resolved.entitlements.scim).toBe(true);
    expect(resolved.entitlements.rbac).toBe(false);
    expect(customerEmails().map((m) => m.category)).toEqual(['billing-contract-ended']);
    expect(opsEmails().map((m) => m.category)).toEqual(['billing-contract-ended-ops']);
  });
});
