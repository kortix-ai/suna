/**
 * Integration test (real local DB): a wallet at $0 tells the owners, once a
 * day, on a paid plan with auto top-up off (KRTX-1718). Before this, agents
 * paused and triggers stopped with nobody told. Captured: the email transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, chatEventDedup, creditAccounts } from '@kortix/db';
import { inArray, like, sql } from 'drizzle-orm';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import { alertWalletAtZero, forgetHandledWalletAlertsForTest } from '../billing/services/wallet-zero-alert';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const ownerEmail = `wallet-zero-owner-${OWNER.slice(0, 8)}@example.test`;

let paid: SeededProject;
let free: SeededProject;
let refilling: SeededProject;
let sent: EmailMessage[] = [];

beforeAll(async () => {
  paid = await seedProject('wallet-zero-paid');
  free = await seedProject('wallet-zero-free');
  refilling = await seedProject('wallet-zero-refilling');
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${OWNER}::uuid, ${ownerEmail}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  for (const account of [paid, free, refilling]) {
    await insertIntoView(db, accountMembers, { userId: OWNER, accountId: account.account_id, accountRole: 'owner' });
  }
  await db.insert(creditAccounts).values([
    { accountId: paid.account_id, tier: 'tier_2_20', autoTopupEnabled: false },
    { accountId: free.account_id, tier: 'free', autoTopupEnabled: false },
    { accountId: refilling.account_id, tier: 'tier_2_20', autoTopupEnabled: true },
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
  if (!paid) return;
  const ids = [paid, free, refilling].map((a) => a.account_id);
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, 'billing:wallet-zero:%'));
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, ids));
  await removeSeeded([paid, free, refilling]);
  await db.execute(sql`delete from auth.users where id = ${OWNER}::uuid`);
});

describe('a wallet at $0', () => {
  test('on a paid plan with auto top-up off: the owner gets one email with the balance and the billing link', async () => {
    expect(await alertWalletAtZero(paid.account_id, -0.5)).toBe(1);
    expect(sent.map((m) => m.to)).toEqual([[ownerEmail]]);
    expect(sent[0]!.subject).toBe('wallet-zero-paid-account is out of credits');
    expect(sent[0]!.text).toContain('The balance of wallet-zero-paid-account reached -$0.50.');
    expect(sent[0]!.text).toContain('Agents pause, and triggers stop starting sessions, until credits are added.');
    expect(sent[0]!.text).toContain(`/projects?accountId=${paid.account_id}&accountTab=billing`);
    expect(sent[0]!.category).toBe('billing-wallet-zero');
  });

  test('later debits the same day email nobody, on this replica or another', async () => {
    expect(await alertWalletAtZero(paid.account_id, -1)).toBe(0);
    forgetHandledWalletAlertsForTest();
    expect(await alertWalletAtZero(paid.account_id, -1)).toBe(0);
    expect(sent).toEqual([]);
  });

  test('a positive balance, a free plan, or auto top-up on: no email', async () => {
    expect(await alertWalletAtZero(paid.account_id, 2)).toBe(0);
    expect(await alertWalletAtZero(free.account_id, 0)).toBe(0);
    expect(await alertWalletAtZero(refilling.account_id, 0)).toBe(0);
    expect(sent).toEqual([]);
  });
});
