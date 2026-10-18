/**
 * Integration test (real local DB): a new subprocessor is announced to every
 * paid account 30 days before it takes effect (DPA section 7.3), once.
 * Captured: the email transport. Everything else is real: credit_accounts,
 * account members, auth users and chat_event_dedup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, creditAccounts } from '@kortix/db';
import type { Subprocessor } from '@kortix/shared/subprocessors';
import { eq, sql } from 'drizzle-orm';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import { openSubprocessorNotices, runSubprocessorNoticeSweep } from '../billing/services/subprocessor-notices';
import { config } from '../config';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const FREE_OWNER = crypto.randomUUID();
const email = (id: string, role: string) => `subproc-${role}-${id.slice(0, 8)}@example.test`;

const ROWS: Subprocessor[] = [
  { name: 'Established Hosting, Inc.', purpose: 'Hosting', location: 'United Kingdom' },
  { name: 'Example Inference, Inc.', purpose: 'Inference for Kortix-managed AI models', location: 'United States', noticeDate: '2026-10-19' },
];

let paid: SeededProject;
let free: SeededProject;
let sent: EmailMessage[] = [];
const savedEnv = config.INTERNAL_KORTIX_ENV;

beforeAll(async () => {
  paid = await seedProject('subproc-paid');
  free = await seedProject('subproc-free');
  for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member'], [FREE_OWNER, 'free-owner']] as const) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${id}::uuid, ${email(id, role)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  }
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: paid.account_id, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: ADMIN, accountId: paid.account_id, accountRole: 'admin' });
  await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: paid.account_id, accountRole: 'member' });
  await insertIntoView(db, accountMembers, { userId: FREE_OWNER, accountId: free.account_id, accountRole: 'owner' });
  await db.insert(creditAccounts).values([
    { accountId: paid.account_id, tier: 'credits' },
    { accountId: free.account_id, tier: 'free' },
  ]);
  setOwnerAlertSenderForTest(async (message) => {
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
}, 20_000);

beforeEach(() => {
  sent = [];
  config.INTERNAL_KORTIX_ENV = 'prod';
});

afterAll(async () => {
  setOwnerAlertSenderForTest(null);
  config.INTERNAL_KORTIX_ENV = savedEnv;
  if (!paid) return;
  for (const account of [paid, free]) {
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, account.account_id));
  }
  await removeSeeded([paid, free]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ADMIN}::uuid, ${MEMBER}::uuid, ${FREE_OWNER}::uuid)`);
});

describe('open subprocessor notices', () => {
  test('a notice is open from its notice date until the day before it takes effect, 30 days later', () => {
    expect(openSubprocessorNotices(ROWS, '2026-10-18')).toEqual([]);
    const [onDay] = openSubprocessorNotices(ROWS, '2026-10-19');
    expect(onDay).toEqual({ noticeDate: '2026-10-19', effectiveDate: '2026-11-18', rows: [ROWS[1]!] });
    expect(openSubprocessorNotices(ROWS, '2026-11-17')).toHaveLength(1);
    expect(openSubprocessorNotices(ROWS, '2026-11-18')).toEqual([]);
  });
});

describe('the subprocessor notice sweep', () => {
  test('emails the owner and the admin of a paid account (not the member, not a free account), once', async () => {
    const now = new Date('2026-10-20T09:00:00Z');
    await runSubprocessorNoticeSweep(now, ROWS);

    const to = sent.flatMap((message) => message.to).sort();
    expect(to).toEqual([email(ADMIN, 'admin'), email(OWNER, 'owner')].sort());
    const [message] = sent;
    expect(message!.subject).toBe('Kortix subprocessor update, effective November 18, 2026');
    expect(message!.category).toBe('legal-subprocessor-notice');
    expect(message!.replyTo).toBe('privacy@kortix.com');
    expect(message!.text).toContain('Example Inference, Inc.: Inference for Kortix-managed AI models (United States)');
    expect(message!.text).toContain('/legal/subprocessors');
    expect(message!.text).not.toContain('Established Hosting');

    sent = [];
    await runSubprocessorNoticeSweep(new Date('2026-10-20T10:00:00Z'), ROWS);
    expect(sent).toEqual([]);
  });

  test('outside prod the sweep emails nobody', async () => {
    config.INTERNAL_KORTIX_ENV = 'dev';
    const rows: Subprocessor[] = [{ ...ROWS[1]!, noticeDate: '2026-10-21' }];
    expect(await runSubprocessorNoticeSweep(new Date('2026-10-21T09:00:00Z'), rows)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });
});
