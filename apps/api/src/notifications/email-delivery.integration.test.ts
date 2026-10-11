// The immediate automation alert email on PostgreSQL (KRTX-1742): addressed to
// the user's auth email, rendered with absolute links, and the outcome the
// notifier stamps (`sent` / `skipped` / `failed`). Captured: the transport.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { EmailMessage, EmailSendResult } from '../lib/email/types';
import { db } from '../shared/db';
import { IMMEDIATE_EMAIL_CATEGORY, sendImmediateNotificationEmail, setNotificationEmailSenderForTest, type ImmediateEmailInput } from './email-delivery';
import { absoluteAppUrl } from './notification-email';

const userId = crypto.randomUUID();
const email = `alert-${userId.slice(0, 8)}@example.test`;
let sent: EmailMessage[] = [];
let answer: () => Promise<EmailSendResult> = async () => ({ ok: true, provider: 'mailpit', status: 200 });

const alert = (over: Partial<ImmediateEmailInput> = {}): ImmediateEmailInput => ({
  notificationId: crypto.randomUUID(),
  userId,
  accountId: crypto.randomUUID(),
  kind: 'automation_failed',
  title: 'Nightly report',
  body: 'Insufficient credits',
  url: '/projects/p1/customize/triggers?notification=n1',
  ...over,
});

setNotificationEmailSenderForTest(async (message) => {
  sent.push(message);
  return answer();
});

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${userId}::uuid, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
});

beforeEach(() => {
  sent = [];
  answer = async () => ({ ok: true, provider: 'mailpit', status: 200 });
});

afterAll(async () => {
  setNotificationEmailSenderForTest(null);
  await db.execute(sql`delete from auth.users where id = ${userId}::uuid`);
});

describe('the immediate automation alert email', () => {
  test('goes to the user\'s address with the alert category, the error and an absolute link', async () => {
    expect(await sendImmediateNotificationEmail(alert())).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: [email], category: IMMEDIATE_EMAIL_CATEGORY, subject: 'Automation failing: Nightly report' });
    expect(sent[0]!.text).toContain('Error: Insufficient credits');
    expect(sent[0]!.text).toContain(`Open automations: ${absoluteAppUrl('/projects/p1/customize/triggers?notification=n1')}`);
  });

  test('a recovery says the automation works again', async () => {
    expect(await sendImmediateNotificationEmail(alert({ kind: 'automation_recovered', body: '' }))).toBe('sent');
    expect(sent[0]!.subject).toBe('Automation working again: Nightly report');
  });

  test('no address, a reserved test domain or a non-automation kind is skipped; a provider error or a throw is failed', async () => {
    expect(await sendImmediateNotificationEmail(alert({ userId: crypto.randomUUID() }))).toBe('skipped');
    expect(await sendImmediateNotificationEmail(alert({ kind: 'question' }))).toBe('skipped');
    expect(sent).toEqual([]);

    answer = async () => ({ ok: false, skipped: true, reason: 'reserved_recipient' });
    expect(await sendImmediateNotificationEmail(alert())).toBe('skipped');
    answer = async () => ({ ok: false, provider: 'ses', status: 500, error: 'provider down' });
    expect(await sendImmediateNotificationEmail(alert())).toBe('failed');
    answer = async () => { throw new Error('socket closed'); };
    expect(await sendImmediateNotificationEmail(alert())).toBe('failed');
  });
});
