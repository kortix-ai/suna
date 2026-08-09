// Shared transactional-email transport with a provider fallback chain.
//
// Born out of the 2026-08-05 Mailtrap suspension: a single email vendor is a
// single point of failure for invites, access requests, and lead
// notifications, so every send now walks EMAIL_PROVIDER_ORDER (default
// "ses,resend,mailtrap") and falls through to the next configured provider on
// any failure. A provider is "configured" iff its credentials are present, so
// each environment enables only what it has keys for.
//
// All three providers speak plain `fetch` — SES via a SigV4-signed SESv2
// SendEmail call (node:crypto, no AWS SDK dependency) — which keeps this
// module mockable with the same global-fetch pattern the existing email tests
// use.
import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

import { config } from '../../config';

export type EmailProvider = 'ses' | 'resend' | 'mailtrap';

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  // Provider-side label for the send (SES tag / Resend tag / Mailtrap
  // category). Letters, numbers, dashes, underscores only.
  category: string;
  // Defaults to MAILTRAP_FROM_EMAIL / MAILTRAP_FROM_NAME.
  from?: { email: string; name: string };
}

export type EmailSendResult =
  | { ok: true; provider: EmailProvider; status: number }
  | { ok: false; skipped: true; reason: 'email_not_configured' }
  | { ok: false; skipped?: false; provider: EmailProvider; status?: number; error: string };

const SEND_TIMEOUT_MS = 10_000;

function isConfigured(provider: EmailProvider): boolean {
  switch (provider) {
    case 'ses':
      return !!(config.AWS_SES_ACCESS_KEY_ID && config.AWS_SES_SECRET_ACCESS_KEY) || hasAwsWorkloadIdentity();
    case 'resend':
      return !!config.RESEND_API_KEY;
    case 'mailtrap':
      return !!config.MAILTRAP_API_TOKEN;
  }
}

function hasAwsWorkloadIdentity(): boolean {
  return !!(
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    (process.env.AWS_WEB_IDENTITY_TOKEN_FILE && process.env.AWS_ROLE_ARN)
  );
}

/** Providers that will be attempted, in order. Empty = no email delivery. */
export function configuredEmailProviders(): EmailProvider[] {
  return (config.EMAIL_PROVIDER_ORDER || 'ses,resend,mailtrap')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is EmailProvider => p === 'ses' || p === 'resend' || p === 'mailtrap')
    .filter(isConfigured);
}

export function isEmailConfigured(): boolean {
  return configuredEmailProviders().length > 0;
}

function resolveFrom(msg: EmailMessage): { email: string; name: string } {
  return msg.from ?? { email: config.MAILTRAP_FROM_EMAIL, name: config.MAILTRAP_FROM_NAME };
}

// ── AWS SES (SESv2 SendEmail, SigV4) ─────────────────────────────────────────

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

async function sendViaSes(msg: EmailMessage): Promise<EmailSendResult> {
  const region = config.AWS_SES_REGION || 'us-east-2';
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';
  const from = resolveFrom(msg);
  const credentials =
    config.AWS_SES_ACCESS_KEY_ID && config.AWS_SES_SECRET_ACCESS_KEY
      ? {
          accessKeyId: config.AWS_SES_ACCESS_KEY_ID,
          secretAccessKey: config.AWS_SES_SECRET_ACCESS_KEY,
        }
      : await defaultProvider()();

  const body = JSON.stringify({
    FromEmailAddress: `${from.name} <${from.email}>`,
    Destination: { ToAddresses: msg.to },
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: msg.html, Charset: 'UTF-8' } },
      },
    },
    EmailTags: [{ Name: 'category', Value: msg.category }],
  });

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const securityTokenHeader = credentials.sessionToken
    ? `x-amz-security-token:${credentials.sessionToken}\n`
    : '';
  const canonicalHeaders = `content-type:application/json\nhost:${host}\n${securityTokenHeader}x-amz-date:${amzDate}\n`;
  const signedHeaders = credentials.sessionToken
    ? 'content-type;host;x-amz-security-token;x-amz-date'
    : 'content-type;host;x-amz-date';
  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), 'ses'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Amz-Date': amzDate,
      ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
      Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, provider: 'ses', status: res.status, error: text || res.statusText };
  }
  return { ok: true, provider: 'ses', status: res.status };
}

// ── Resend ───────────────────────────────────────────────────────────────────

async function sendViaResend(msg: EmailMessage): Promise<EmailSendResult> {
  const from = resolveFrom(msg);
  // While the primary from-domain is not verified in the Resend team,
  // RESEND_FROM_EMAIL substitutes a verified sender and keeps the intended
  // address as Reply-To.
  const fromEmail = config.RESEND_FROM_EMAIL || from.email;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${from.name} <${fromEmail}>`,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(fromEmail !== from.email ? { reply_to: from.email } : {}),
      tags: [{ name: 'category', value: msg.category }],
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, provider: 'resend', status: res.status, error: text || res.statusText };
  }
  return { ok: true, provider: 'resend', status: res.status };
}

// ── Mailtrap ─────────────────────────────────────────────────────────────────

async function sendViaMailtrap(msg: EmailMessage): Promise<EmailSendResult> {
  const from = resolveFrom(msg);
  const res = await fetch('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.MAILTRAP_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: { email: from.email, name: from.name },
      to: msg.to.map((email) => ({ email })),
      subject: msg.subject,
      html: msg.html,
      category: msg.category,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, provider: 'mailtrap', status: res.status, error: text || res.statusText };
  }
  return { ok: true, provider: 'mailtrap', status: res.status };
}

const SENDERS: Record<EmailProvider, (msg: EmailMessage) => Promise<EmailSendResult>> = {
  ses: sendViaSes,
  resend: sendViaResend,
  mailtrap: sendViaMailtrap,
};

/**
 * Send one transactional email through the first provider in the configured
 * chain that accepts it. Never throws: network errors and non-2xx responses
 * fall through to the next provider; the last failure is returned when the
 * whole chain is exhausted.
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
  const providers = configuredEmailProviders();
  if (providers.length === 0) {
    return { ok: false, skipped: true, reason: 'email_not_configured' };
  }

  let lastFailure: EmailSendResult | null = null;
  for (const provider of providers) {
    let result: EmailSendResult;
    try {
      result = await SENDERS[provider](msg);
    } catch (err) {
      result = { ok: false, provider, error: (err as Error).message };
    }
    if (result.ok) return result;
    console.warn(
      `[email] ${provider} send failed (${'status' in result && result.status ? result.status : 'network'}): ${'error' in result ? result.error : 'unknown'}`,
    );
    lastFailure = result;
  }
  return lastFailure as EmailSendResult;
}
