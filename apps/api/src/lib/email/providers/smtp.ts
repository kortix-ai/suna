// Plain SMTP — the provider every mail system on earth already speaks, and the
// one a self-hoster with a corporate relay can actually use.
//
// Transports are pooled and cached per DSN: opening a TCP+TLS connection per
// invite is wasteful, and nodemailer's pool reuses the socket across sends.
import nodemailer, { type Transporter } from 'nodemailer';

import { formatEmailAddress } from '../address';
import type { EmailTarget } from '@kortix/shared/email-url';
import { EMAIL_SEND_TIMEOUT_MS, type EmailSendResult, type ResolvedEmailMessage } from '../types';

type SmtpTarget = Extract<EmailTarget, { kind: 'smtp' }>;

const transporters = new Map<string, Transporter>();

function cacheKey(target: SmtpTarget): string {
  return [
    target.host,
    target.port,
    target.secure ? 'tls' : 'plain',
    target.requireTls ? 'starttls' : 'opportunistic',
    target.rejectUnauthorized ? 'verify' : 'insecure',
    target.user ?? '',
  ].join('|');
}

function transporterFor(target: SmtpTarget): Transporter {
  const key = cacheKey(target);
  const existing = transporters.get(key);
  if (existing) return existing;

  const created = nodemailer.createTransport({
    host: target.host,
    port: target.port,
    secure: target.secure,
    requireTLS: target.requireTls,
    ...(target.user ? { auth: { user: target.user, pass: target.pass ?? '' } } : {}),
    tls: { rejectUnauthorized: target.rejectUnauthorized },
    pool: true,
    maxConnections: 3,
    connectionTimeout: EMAIL_SEND_TIMEOUT_MS,
    greetingTimeout: EMAIL_SEND_TIMEOUT_MS,
    socketTimeout: EMAIL_SEND_TIMEOUT_MS,
  });
  transporters.set(key, created);
  return created;
}

export async function sendViaSmtp(
  msg: ResolvedEmailMessage,
  target: SmtpTarget,
): Promise<EmailSendResult> {
  try {
    await transporterFor(target).sendMail({
      from: formatEmailAddress(msg.from),
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      headers: { 'X-Kortix-Category': msg.category },
    });
    return { ok: true, provider: 'smtp', status: 250 };
  } catch (err) {
    const error = err as Error & { responseCode?: number };
    return {
      ok: false,
      provider: 'smtp',
      ...(error.responseCode ? { status: error.responseCode } : {}),
      error: error.message || 'SMTP send failed',
    };
  }
}

/** Close pooled sockets. Used by tests and graceful shutdown. */
export function closeSmtpTransports(): void {
  for (const transporter of transporters.values()) transporter.close();
  transporters.clear();
}
