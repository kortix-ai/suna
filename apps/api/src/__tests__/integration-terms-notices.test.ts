/**
 * Integration test (real local DB): a material Terms change is announced to
 * every paid account before it takes effect (Terms section 16), once, and
 * leaves evidence: an audit event per account and a report to legal@.
 * Captured: the email transport. Everything else is real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, auditEvents, creditAccounts } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import { runTermsNoticeSweep, type TermsChange } from '../billing/services/terms-notices';
import { config } from '../config';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const FREE_OWNER = crypto.randomUUID();
const email = (id: string, role: string) => `terms-${role}-${id.slice(0, 8)}@example.test`;

const CHANGE: TermsChange = {
  version: '2026-10-28',
  effectiveDate: '2026-12-04',
  changes: ['Section 10 (Marks and publicity): Kortix may list an organization customer by name and logo.'],
};

let paid: SeededProject;
let free: SeededProject;
let sent: EmailMessage[] = [];
const customerEmails = () => sent.filter((m) => !m.subject.startsWith('[Kortix compliance]'));
const legalReports = () => sent.filter((m) => m.subject.startsWith('[Kortix compliance]'));
const savedEnv = config.INTERNAL_KORTIX_ENV;

beforeAll(async () => {
  paid = await seedProject('terms-paid');
  free = await seedProject('terms-free');
  for (const [id, role] of [[OWNER, 'owner'], [MEMBER, 'member'], [FREE_OWNER, 'free-owner']] as const) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${id}::uuid, ${email(id, role)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  }
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: paid.account_id, accountRole: 'owner' });
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
  for (const accountId of [paid.account_id, free.account_id]) {
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  }
  await db.execute(sql`delete from kortix.chat_event_dedup where event_id like 'legal:terms-notice:%'`);
  await removeSeeded([paid, free]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${MEMBER}::uuid, ${FREE_OWNER}::uuid)`);
});

describe('the Terms notice sweep', () => {
  test('emails the owner of a paid account (not the member, not a free account), once, with evidence', async () => {
    expect(await runTermsNoticeSweep(new Date('2026-10-30T09:00:00Z'), CHANGE)).toEqual({ accountsNotified: 1 });

    const mine = customerEmails().filter((m) => m.to.some((to) => to.endsWith('@example.test') && to.startsWith('terms-')));
    expect(mine.flatMap((m) => m.to)).toEqual([email(OWNER, 'owner')]);
    expect(mine[0]!.subject).toBe('Kortix Terms of Service update, effective December 4, 2026');
    expect(mine[0]!.replyTo).toBe('legal@kortix.com');
    expect(mine[0]!.text).toContain('Kortix may list an organization customer by name and logo');
    expect(mine[0]!.text).toContain('/legal?tab=terms');

    const [audit] = await db
      .select({ resourceId: auditEvents.resourceId, outputSummary: auditEvents.outputSummary })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, paid.account_id), eq(auditEvents.action, 'legal.terms_notice.sent')));
    expect(audit!.resourceId).toBe('2026-10-28');
    expect(audit!.outputSummary).toMatchObject({ recipients: 1, effective_date: '2026-12-04' });
    const freeAudits = await db
      .select({ id: auditEvents.eventId })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, free.account_id), eq(auditEvents.action, 'legal.terms_notice.sent')));
    expect(freeAudits).toEqual([]);

    const [report] = legalReports();
    expect(report!.to).toEqual(['legal@kortix.com']);
    expect(report!.text).toContain('takes effect December 4, 2026, 34 days from now');

    sent = [];
    expect(await runTermsNoticeSweep(new Date('2026-10-30T10:00:00Z'), CHANGE)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });

  test('a notice that starts late tells legal@ how many days it gave', async () => {
    await runTermsNoticeSweep(new Date('2026-11-20T09:00:00Z'), { ...CHANGE, version: '2026-10-29' });
    expect(legalReports()[0]!.subject).toBe('[Kortix compliance] Terms notice gave only 13 days');
  });

  test('no notice outside prod, without changes, or on and after the effective date', async () => {
    expect(await runTermsNoticeSweep(new Date('2026-12-04T09:00:00Z'), { ...CHANGE, version: '2026-10-30' })).toEqual({ accountsNotified: 0 });
    expect(await runTermsNoticeSweep(new Date('2026-11-01T09:00:00Z'), { ...CHANGE, version: '2026-10-31', changes: [] })).toEqual({ accountsNotified: 0 });
    config.INTERNAL_KORTIX_ENV = 'dev';
    expect(await runTermsNoticeSweep(new Date('2026-11-01T09:00:00Z'), { ...CHANGE, version: '2026-11-01' })).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });
});
