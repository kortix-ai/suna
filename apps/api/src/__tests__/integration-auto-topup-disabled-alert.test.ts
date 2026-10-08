/**
 * Integration test (real local DB): when a declined card turns auto top-up
 * off, the owners get one email and the settings say why (KRTX-1718). Before
 * this, the reason sat in `credit_accounts.auto_topup_disabled_reason`, read by
 * no API, and nobody was told; the wallet ran down to $0 and sessions and
 * triggers stopped.
 *
 * Real: the credit account row, the owner and admin memberships, their
 * emails in `auth.users`. Captured: the email transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, creditAccounts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { setAutoTopupAlertSenderForTest } from '../billing/services/auto-topup-alert';
import { getAutoTopupSettings, handleFailedCharge } from '../billing/services/auto-topup';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const ownerEmail = `auto-topup-owner-${OWNER.slice(0, 8)}@example.test`;
const adminEmail = `auto-topup-admin-${ADMIN.slice(0, 8)}@example.test`;

let declined: SeededProject;
let flaky: SeededProject;
let sent: EmailMessage[] = [];

async function row(accountId: string) {
  const [r] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  return r!;
}

beforeAll(async () => {
  declined = await seedProject('auto-topup-declined');
  flaky = await seedProject('auto-topup-flaky');
  const user = (id: string, email: string) =>
    sql`(${id}::uuid, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role) values ${user(OWNER, ownerEmail)}, ${user(ADMIN, adminEmail)}`);
  for (const account of [declined, flaky]) {
    await insertIntoView(db, accountMembers, { userId: OWNER, accountId: account.account_id, accountRole: 'owner' });
    await insertIntoView(db, accountMembers, { userId: ADMIN, accountId: account.account_id, accountRole: 'admin' });
    await db.insert(creditAccounts).values({ accountId: account.account_id, tier: 'pro', autoTopupEnabled: true });
  }
  setAutoTopupAlertSenderForTest(async (message) => {
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
}, 20_000);

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  setAutoTopupAlertSenderForTest(null);
  if (!declined) return;
  for (const account of [declined, flaky]) {
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, account.account_id));
  }
  await removeSeeded([declined, flaky]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ADMIN}::uuid)`);
});

describe('auto top-up turned off by a declined card', () => {
  test('a hard decline turns it off and emails the owner once, with the reason and the billing link', async () => {
    await handleFailedCharge(declined.account_id, 0, 'insufficient_funds', true);

    expect(await row(declined.account_id)).toMatchObject({
      autoTopupEnabled: false,
      autoTopupDisabledReason: 'insufficient_funds',
      autoTopupConsecutiveFailures: 1,
    });
    expect(sent.map((m) => m.to)).toEqual([[ownerEmail]]);
    expect(sent[0]!.subject).toBe('Auto top-up is off for auto-topup-declined-account');
    expect(sent[0]!.text).toContain('The card has insufficient funds. (insufficient_funds)');
    expect(sent[0]!.text).toContain(`/projects?accountId=${declined.account_id}&accountTab=billing`);
    expect(sent[0]!.category).toBe('billing-auto-topup-disabled');
  });

  test('a later failure on the account that is already off sends no second email', async () => {
    await handleFailedCharge(declined.account_id, 1, 'insufficient_funds', true);
    expect(sent).toEqual([]);
    expect((await row(declined.account_id)).autoTopupConsecutiveFailures).toBe(2);
  });

  test('the settings say why it is off', async () => {
    const settings = await getAutoTopupSettings(declined.account_id);
    expect(settings).toMatchObject({
      enabled: false,
      disabled_reason: 'insufficient_funds',
      last_failure_reason: 'insufficient_funds',
    });
    expect(Number.isNaN(Date.parse(settings.last_failure_at ?? ''))).toBe(false);
  });
});

describe('a soft failure', () => {
  test('keeps auto top-up on, emails nobody, and still shows the failure', async () => {
    await handleFailedCharge(flaky.account_id, 0, 'processing_error', false);

    expect((await row(flaky.account_id)).autoTopupEnabled).toBe(true);
    expect(sent).toEqual([]);
    expect(await getAutoTopupSettings(flaky.account_id)).toMatchObject({
      enabled: true,
      disabled_reason: null,
      last_failure_reason: 'processing_error',
    });
  });

  test('the third failure in a row turns it off and emails the owner', async () => {
    await handleFailedCharge(flaky.account_id, 1, 'processing_error', false);
    expect(sent).toEqual([]);
    await handleFailedCharge(flaky.account_id, 2, 'processing_error', false);
    expect((await row(flaky.account_id)).autoTopupEnabled).toBe(false);
    expect(sent.map((m) => m.to)).toEqual([[ownerEmail]]);
    expect(sent[0]!.text).toContain('The charge failed. (processing_error)');
  });
});
