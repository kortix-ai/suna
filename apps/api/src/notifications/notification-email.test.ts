// Notification email copy (KRTX-1742): the brand rules for transactional mail
// (voice-and-tone.md 5.5) and the digest's "10 plus N more" list.
import { describe, expect, test } from 'bun:test';
import { BRAND_FOOTER } from '../lib/email/template';
import {
  absoluteAppUrl,
  renderImmediateNotificationEmail,
  renderNotificationDigestEmail,
  type NotificationEmailItem,
} from './notification-email';

const PID = '00000000-0000-4000-8000-000000000001';
const failed: NotificationEmailItem = {
  kind: 'automation_failed',
  title: 'Nightly report',
  body: 'Insufficient credits',
  url: `/projects/${PID}/customize/triggers?notification=n1`,
};

function item(i: number): NotificationEmailItem {
  return { kind: 'question', title: `Session ${i}`, body: `Which region, ${i}?`, url: `/projects/${PID}/sessions/s${i}?notification=n${i}` };
}

const variants = () => [
  renderImmediateNotificationEmail({ ...failed, title: 'T', body: '' })!,
  renderImmediateNotificationEmail({ ...failed, kind: 'automation_recovered', title: 'T', body: '' })!,
  renderNotificationDigestEmail({ items: [{ ...item(1), kind: 'shared', title: 'S', body: '' }], more: 0 }),
  renderNotificationDigestEmail({ items: Array.from({ length: 10 }, (_, i) => item(i)), more: 5 }),
];

describe('notification emails follow the transactional email rules', () => {
  test('every variant keeps its HTML above 3,200 bytes and ends with the tagline in both parts', () => {
    for (const email of variants()) {
      expect(email.html.length).toBeGreaterThan(3200);
      expect(email.html).toContain(BRAND_FOOTER);
      expect(email.text!.endsWith(BRAND_FOOTER)).toBe(true);
    }
  });

  test('no exclamation marks, no uppercase kicker', () => {
    for (const email of variants()) {
      expect(`${email.subject}\n${email.text}`).not.toContain('!');
      const kicker = /font-weight:500;[^"]*">([^<]+)<\/div>/.exec(email.html)?.[1] ?? '';
      expect(kicker).not.toBe(kicker.toUpperCase());
    }
  });

  test('links are absolute app URLs that open the subject', () => {
    const email = renderImmediateNotificationEmail(failed)!;
    const href = absoluteAppUrl(failed.url);
    expect(href).toMatch(/^https?:\/\/[^/]+\/projects\//);
    expect(email.html).toContain(href.replace(/&/g, '&amp;'));
    expect(email.text).toContain(`Open automations: ${href}`);
  });

  test('the failing alert names the automation and the error; user text is escaped', () => {
    const email = renderImmediateNotificationEmail({ ...failed, title: '<b>Deploy</b>' })!;
    expect(email.subject).toBe('Automation failing: <b>Deploy</b>');
    expect(email.html).toContain('&lt;b&gt;Deploy&lt;/b&gt;');
    expect(email.html).not.toContain('<b>Deploy</b>');
    expect(email.text).toContain('Error: Insufficient credits');
  });

  test('only automation kinds have an immediate email; the rest wait for the digest', () => {
    expect(renderImmediateNotificationEmail({ ...item(1), kind: 'question' })).toBeNull();
    expect(renderImmediateNotificationEmail({ ...item(1), kind: 'turn_done' })).toBeNull();
  });
});

describe('the digest', () => {
  test('lists the items given and counts the rest', () => {
    const email = renderNotificationDigestEmail({ items: Array.from({ length: 10 }, (_, i) => item(i)), more: 5 });
    expect(email.subject).toBe('Review 15 unread notifications in Kortix');
    for (let i = 0; i < 10; i += 1) {
      expect(email.text).toContain(`Question waiting: Session ${i}\nWhich region, ${i}?\n${absoluteAppUrl(item(i).url)}`);
    }
    expect(email.text).toContain('And 5 more.');
    expect(email.html).toContain('And 5 more.');
  });

  test('one item: singular copy and no "more" line', () => {
    const email = renderNotificationDigestEmail({ items: [item(1)], more: 0 });
    expect(email.subject).toBe('Review 1 unread notification in Kortix');
    expect(email.text).toContain('This notification was unread for 15 minutes or more.');
    expect(email.text).not.toContain('And ');
    expect(email.html).not.toContain('And 0 more');
  });
});
