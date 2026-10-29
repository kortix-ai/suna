/**
 * Integration test (real local DB): a material Terms change is announced to
 * every signed-up user before it takes effect (Terms section 16), free or
 * paid, once, in hourly batches, and leaves evidence: an audit event per user
 * and a report to legal@. Captured: the email transport. Everything else is real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { auditEvents } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import { runTermsNoticeSweep, type TermsChange } from '../billing/services/terms-notices';
import { config } from '../config';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';

const FREE_USER = crypto.randomUUID();
const PAID_USER = crypto.randomUUID();
const DELETED_USER = crypto.randomUUID();
const email = (id: string, role: string) => `terms-${role}-${id.slice(0, 8)}@example.test`;
const MINE = [email(FREE_USER, 'free'), email(PAID_USER, 'paid')].sort();

const CHANGE: TermsChange = {
  version: '2026-10-28',
  effectiveDate: '2026-12-04',
  changes: ['Section 10 (Marks and publicity): Kortix may show the name and logo of any customer organization.'],
};

let sent: EmailMessage[] = [];
const customerEmails = () => sent.filter((m) => !m.subject.startsWith('[Kortix compliance]'));
const legalReports = () => sent.filter((m) => m.subject.startsWith('[Kortix compliance]'));
const mine = () => customerEmails().flatMap((m) => m.to).filter((to) => to.startsWith('terms-')).sort();
const savedEnv = config.INTERNAL_KORTIX_ENV;

beforeAll(async () => {
  for (const [id, role] of [[FREE_USER, 'free'], [PAID_USER, 'paid'], [DELETED_USER, 'deleted']] as const) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${id}::uuid, ${email(id, role)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  }
  await db.execute(sql`update auth.users set deleted_at = now() where id = ${DELETED_USER}::uuid`);
  setOwnerAlertSenderForTest(async (message) => {
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
});

beforeEach(() => {
  sent = [];
  config.INTERNAL_KORTIX_ENV = 'prod';
});

afterAll(async () => {
  setOwnerAlertSenderForTest(null);
  config.INTERNAL_KORTIX_ENV = savedEnv;
  await db.execute(sql`delete from kortix.chat_event_dedup where event_id like 'legal:terms-notice:%'`);
  await db.execute(sql`delete from auth.users where id in (${FREE_USER}::uuid, ${PAID_USER}::uuid, ${DELETED_USER}::uuid)`);
});

describe('the Terms notice sweep', () => {
  test('emails every signed-up user once, free or paid, not a deleted user, in batches, with evidence', async () => {
    const now = new Date('2026-10-30T09:00:00Z');
    expect(await runTermsNoticeSweep(now, CHANGE, 1)).toEqual({ usersNotified: 1 });
    expect(legalReports()).toEqual([]);

    // Drain the rest of the users in the database.
    for (let i = 0; i < 100 && (await runTermsNoticeSweep(now, CHANGE, 1000)).usersNotified > 0; i++);
    expect(mine()).toEqual(MINE);

    const [message] = customerEmails().filter((m) => m.to[0] === email(FREE_USER, 'free'));
    expect(message!.subject).toBe('Kortix Terms of Service update, effective December 4, 2026');
    expect(message!.replyTo).toBe('legal@kortix.com');
    expect(message!.text).toContain('applies to every Kortix account, free or paid');
    expect(message!.text).toContain('Kortix may show the name and logo of any customer organization');
    expect(message!.text).toContain('/legal?tab=terms');

    const audits = await db
      .select({ outputSummary: auditEvents.outputSummary })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'legal.terms_notice.sent'), eq(auditEvents.resourceId, '2026-10-28')));
    const audited = audits.map((a) => (a.outputSummary as { user_id: string }).user_id);
    expect(audited).toContain(FREE_USER);
    expect(audited).toContain(PAID_USER);
    expect(audited).not.toContain(DELETED_USER);

    const [report] = legalReports();
    expect(report!.to).toEqual(['legal@kortix.com']);
    expect(report!.text).toContain('every signed-up user');
    expect(report!.text).toContain('takes effect December 4, 2026, 34 days from now');

    sent = [];
    expect(await runTermsNoticeSweep(new Date('2026-10-30T10:00:00Z'), CHANGE)).toEqual({ usersNotified: 0 });
    expect(sent).toEqual([]);
  });

  test('a notice that starts late tells legal@ how many days it gave', async () => {
    await runTermsNoticeSweep(new Date('2026-11-20T09:00:00Z'), { ...CHANGE, version: '2026-10-29' }, 1);
    expect(legalReports()[0]!.subject).toBe('[Kortix compliance] Terms notice gave only 13 days');
  });

  test('no notice outside prod, without changes, or on and after the effective date', async () => {
    expect(await runTermsNoticeSweep(new Date('2026-12-04T09:00:00Z'), { ...CHANGE, version: '2026-10-30' })).toEqual({ usersNotified: 0 });
    expect(await runTermsNoticeSweep(new Date('2026-11-01T09:00:00Z'), { ...CHANGE, version: '2026-10-31', changes: [] })).toEqual({ usersNotified: 0 });
    config.INTERNAL_KORTIX_ENV = 'dev';
    expect(await runTermsNoticeSweep(new Date('2026-11-01T09:00:00Z'), { ...CHANGE, version: '2026-11-01' })).toEqual({ usersNotified: 0 });
    expect(sent).toEqual([]);
  });
});
