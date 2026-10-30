/**
 * Integration test (real local DB): a new subprocessor is announced to every
 * paid account 30 days before it takes effect (DPA section 7.3), once, and
 * leaves evidence: an audit event per account and a report to privacy@.
 * Captured: the email transport. Everything else is real: credit_accounts,
 * account members, auth users, audit_events and chat_event_dedup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, auditEvents, creditAccounts } from '@kortix/db';
import type { Subprocessor } from '@kortix/shared/subprocessors';
import { and, eq, sql } from 'drizzle-orm';
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
// A Suna-era account still billed: no Kortix account row, its owner only in basejump.account_user.
const LEGACY_ACCOUNT = crypto.randomUUID();
const LEGACY_OWNER = crypto.randomUUID();
// A paid account nobody can be emailed for yet.
const UNREACHABLE_ACCOUNT = crypto.randomUUID();
const email = (id: string, role: string) => `subproc-${role}-${id.slice(0, 8)}@example.test`;

const ROWS: Subprocessor[] = [
  { name: 'Established Hosting, Inc.', purpose: 'Hosting', location: 'United Kingdom' },
  { name: 'Example Inference, Inc.', purpose: 'Inference for Kortix-managed AI models', location: 'United States', addedOn: '2026-10-18' },
];

let paid: SeededProject;
let free: SeededProject;
let sent: EmailMessage[] = [];
const customerEmails = () => sent.filter((m) => !m.subject.startsWith('[Kortix compliance]'));
const privacyReports = () => sent.filter((m) => m.subject.startsWith('[Kortix compliance]'));
const savedEnv = config.INTERNAL_KORTIX_ENV;

beforeAll(async () => {
  paid = await seedProject('subproc-paid');
  free = await seedProject('subproc-free');
  for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member'], [FREE_OWNER, 'free-owner'], [LEGACY_OWNER, 'legacy-owner']] as const) {
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
    { accountId: LEGACY_ACCOUNT, tier: 'tier_2_20' },
    { accountId: UNREACHABLE_ACCOUNT, tier: 'credits' },
  ]);
  await db.execute(sql`insert into basejump.account_user (user_id, account_id, account_role) values (${LEGACY_OWNER}::uuid, ${LEGACY_ACCOUNT}::uuid, 'owner')`);
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
  for (const accountId of [paid.account_id, free.account_id, LEGACY_ACCOUNT, UNREACHABLE_ACCOUNT]) {
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  }
  await db.execute(sql`delete from basejump.account_user where account_id = ${LEGACY_ACCOUNT}::uuid`);
  await db.execute(sql`delete from kortix.chat_event_dedup where event_id like 'legal:subprocessor-notice:%'`);
  await removeSeeded([paid, free]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ADMIN}::uuid, ${MEMBER}::uuid, ${FREE_OWNER}::uuid, ${LEGACY_OWNER}::uuid)`);
});

describe('open subprocessor notices', () => {
  test('a notice is open from the day its row is added until the day before it takes effect, 37 days later', () => {
    expect(openSubprocessorNotices(ROWS, '2026-10-17')).toEqual([]);
    const [onDay] = openSubprocessorNotices(ROWS, '2026-10-18');
    expect(onDay).toEqual({ addedOn: '2026-10-18', effectiveDate: '2026-11-24', rows: [ROWS[1]!] });
    expect(openSubprocessorNotices(ROWS, '2026-11-23')).toHaveLength(1);
    expect(openSubprocessorNotices(ROWS, '2026-11-24')).toEqual([]);
  });
});

describe('the subprocessor notice sweep', () => {
  test('emails the owner and the admin of a paid account (not the member, not a free account), once, with evidence', async () => {
    const now = new Date('2026-10-20T09:00:00Z');
    expect(await runSubprocessorNoticeSweep(now, ROWS)).toEqual({ accountsNotified: 2 });

    const to = customerEmails().flatMap((message) => message.to).sort();
    expect(to).toEqual([email(ADMIN, 'admin'), email(OWNER, 'owner'), email(LEGACY_OWNER, 'legacy-owner')].sort());
    const [message] = customerEmails().filter((m) => m.to[0] !== email(LEGACY_OWNER, 'legacy-owner'));
    expect(message!.subject).toBe('Kortix subprocessor update, effective November 24, 2026');
    expect(message!.category).toBe('legal-subprocessor-notice');
    expect(message!.replyTo).toBe('privacy@kortix.com');
    expect(message!.text).toContain('Example Inference, Inc.: Inference for Kortix-managed AI models (United States)');
    expect(message!.text).toContain('/legal/subprocessors');
    expect(message!.text).not.toContain('Established Hosting');

    const [audit] = await db
      .select({ resourceId: auditEvents.resourceId, outputSummary: auditEvents.outputSummary })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, paid.account_id), eq(auditEvents.action, 'legal.subprocessor_notice.sent')));
    expect(audit!.resourceId).toBe('2026-10-18');
    expect(audit!.outputSummary).toMatchObject({ recipients: 2, effective_date: '2026-11-24', subprocessors: ['Example Inference, Inc.'] });
    const freeAudits = await db
      .select({ id: auditEvents.eventId })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, free.account_id), eq(auditEvents.action, 'legal.subprocessor_notice.sent')));
    expect(freeAudits).toEqual([]);

    const [report] = privacyReports();
    expect(report!.to).toEqual(['privacy@kortix.com']);
    expect(report!.subject).toBe('[Kortix compliance] Subprocessor notice sent to 2 accounts');
    expect(report!.text).toContain('takes effect November 24, 2026, 34 days from now');

    sent = [];
    expect(await runSubprocessorNoticeSweep(new Date('2026-10-20T10:00:00Z'), ROWS)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });

  test('an account with nobody to email is retried by a later sweep, not dropped', async () => {
    const owner = crypto.randomUUID();
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${owner}::uuid, ${email(owner, 'late-owner')}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    await db.execute(sql`insert into basejump.account_user (user_id, account_id, account_role) values (${owner}::uuid, ${UNREACHABLE_ACCOUNT}::uuid, 'owner')`);
    try {
      expect(await runSubprocessorNoticeSweep(new Date('2026-10-20T11:00:00Z'), ROWS)).toEqual({ accountsNotified: 1 });
      expect(customerEmails().flatMap((message) => message.to)).toEqual([email(owner, 'late-owner')]);
    } finally {
      await db.execute(sql`delete from basejump.account_user where account_id = ${UNREACHABLE_ACCOUNT}::uuid`);
      await db.execute(sql`delete from auth.users where id = ${owner}::uuid`);
    }
  });

  test('a notice that starts late tells privacy@ how many days it gave', async () => {
    // Added 2026-10-01, effective 2026-11-07, first seen on prod 2026-10-20: a 10-day-late release.
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-10-01' }];
    await runSubprocessorNoticeSweep(new Date('2026-10-20T09:00:00Z'), rows);
    const [report] = privacyReports();
    expect(report!.subject).toBe('[Kortix compliance] Subprocessor notice gave only 17 days');
    expect(report!.text).toContain('Send no customer data to these subprocessors until 30 days from now');
  });

  test('outside prod the sweep emails nobody', async () => {
    config.INTERNAL_KORTIX_ENV = 'dev';
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-10-21' }];
    expect(await runSubprocessorNoticeSweep(new Date('2026-10-21T09:00:00Z'), rows)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });
});
