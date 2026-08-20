// The three HTTP-API providers. Each speaks plain `fetch`, so the whole set
// stays mockable through globalThis.fetch in tests.
import { formatEmailAddress } from '../address';
import type { EmailTarget } from '@kortix/shared/email-url';
import { EMAIL_SEND_TIMEOUT_MS, type EmailSendResult, type ResolvedEmailMessage } from '../types';

export async function sendViaResend(
  msg: ResolvedEmailMessage,
  target: Extract<EmailTarget, { kind: 'resend' }>,
): Promise<EmailSendResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: formatEmailAddress(msg.from),
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      tags: [{ name: 'category', value: msg.category }],
    }),
    signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, provider: 'resend', status: res.status, error: text || res.statusText };
  }
  return { ok: true, provider: 'resend', status: res.status };
}

export async function sendViaMailtrap(
  msg: ResolvedEmailMessage,
  target: Extract<EmailTarget, { kind: 'mailtrap' }>,
): Promise<EmailSendResult> {
  const res = await fetch('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: { email: msg.from.email, name: msg.from.name },
      to: msg.to.map((email) => ({ email })),
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
      category: msg.category,
    }),
    signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, provider: 'mailtrap', status: res.status, error: text || res.statusText };
  }
  return { ok: true, provider: 'mailtrap', status: res.status };
}

/** Local capture only — Mailpit's HTTP send API, used by the test profile. */
export async function sendViaMailpit(
  msg: ResolvedEmailMessage,
  target: Extract<EmailTarget, { kind: 'mailpit' }>,
): Promise<EmailSendResult> {
  const res = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/api/v1/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      From: { Email: msg.from.email, Name: msg.from.name },
      To: msg.to.map((email) => ({ Email: email })),
      Subject: msg.subject,
      HTML: msg.html,
      Text: msg.text,
      Tags: [msg.category],
    }),
    signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, provider: 'mailpit', status: res.status, error: text || res.statusText };
  }
  return { ok: true, provider: 'mailpit', status: res.status };
}
