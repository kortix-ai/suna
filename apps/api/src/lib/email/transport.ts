// One transactional-email transport for the whole platform.
//
// Every email Kortix sends — account invites, project invites, access
// requests, demo leads, and (via the Supabase send-email hook) magic links,
// signup confirmations and password recovery — goes through sendEmail() here.
// One sender identity, one provider chain, one place to add a provider.
//
// Configuration is a single connection string, EMAIL_URL (see dsn.ts), plus
// EMAIL_FROM for the sender identity. The per-provider env vars that predate
// it (RESEND_API_KEY, AWS_SES_*, MAILTRAP_API_TOKEN, MAILPIT_API_URL,
// EMAIL_PROVIDER_ORDER) still work unchanged and are used whenever EMAIL_URL
// is unset, so deployed environments keep sending with no env change.
//
// The chain exists because a single vendor is a single point of failure: the
// 2026-08-05 Mailtrap suspension took invites down. Any failure falls through
// to the next configured provider.
import { config } from '../../config';
import { formatEmailAddress, parseEmailAddress } from './address';
import { parseEmailTargets, type EmailTarget } from '@kortix/shared/email-url';
import { sendViaMailpit, sendViaMailtrap, sendViaResend } from './providers/http';
import { sendViaSes } from './providers/ses';
import { sendViaSmtp } from './providers/smtp';
import type {
  EmailAddress,
  EmailMessage,
  EmailProvider,
  EmailSendResult,
  ResolvedEmailMessage,
} from './types';

export type { EmailAddress, EmailMessage, EmailProvider, EmailSendResult } from './types';
export { closeSmtpTransports } from './providers/smtp';

const FALLBACK_FROM: EmailAddress = { email: 'noreply@kortix.com', name: 'Kortix' };

let loggedUrlErrors = '';

/**
 * The ordered provider chain plus the sender identity, resolved fresh on every
 * call: config is read lazily so tests (and a future hot-reload) see current
 * values rather than a snapshot taken at import time.
 */
export function resolveEmailChain(): { targets: EmailTarget[]; from: EmailAddress } {
  const from = resolveSender();

  const raw = (config.EMAIL_URL || '').trim();
  if (raw) {
    const { targets, errors } = parseEmailTargets(raw);
    if (errors.length) {
      // Log each distinct fault once — a bad EMAIL_URL is a startup-class
      // mistake and must not spam a line per send.
      const fingerprint = errors.join('|');
      if (fingerprint !== loggedUrlErrors) {
        loggedUrlErrors = fingerprint;
        for (const error of errors) console.error(`[email] ignoring EMAIL_URL entry: ${error}`);
      }
    }
    return { targets, from };
  }

  return { targets: legacyTargets(), from };
}

/**
 * EMAIL_FROM wins. Without it the pre-EMAIL_FROM pair is used: the MAILTRAP_
 * prefix is historical — those two have always set the global sender identity,
 * whichever provider actually did the sending.
 */
function resolveSender(): EmailAddress {
  const explicit = parseEmailAddress(config.EMAIL_FROM);
  if (explicit) return explicit;
  const legacy = (config.MAILTRAP_FROM_EMAIL || '').trim();
  if (legacy) return { email: legacy, name: config.MAILTRAP_FROM_NAME || '' };
  return FALLBACK_FROM;
}

/**
 * Build the chain from the pre-EMAIL_URL environment variables. Deployed Kortix
 * (dev/staging/prod) still runs on these, so this path is load-bearing, not a
 * deprecation shim.
 */
function legacyTargets(): EmailTarget[] {
  const order = (config.EMAIL_PROVIDER_ORDER || 'ses,resend,mailtrap,smtp')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const targets: EmailTarget[] = [];
  for (const provider of order) {
    switch (provider) {
      case 'ses': {
        const hasStatic = !!(config.AWS_SES_ACCESS_KEY_ID && config.AWS_SES_SECRET_ACCESS_KEY);
        if (!hasStatic && !hasAwsWorkloadIdentity()) break;
        targets.push({
          kind: 'ses',
          region: config.AWS_SES_REGION || 'us-east-2',
          ...(hasStatic
            ? {
                accessKeyId: config.AWS_SES_ACCESS_KEY_ID,
                secretAccessKey: config.AWS_SES_SECRET_ACCESS_KEY,
              }
            : {}),
        });
        break;
      }
      case 'resend':
        if (config.RESEND_API_KEY) targets.push({ kind: 'resend', apiKey: config.RESEND_API_KEY });
        break;
      case 'mailtrap':
        if (config.MAILTRAP_API_TOKEN) {
          targets.push({ kind: 'mailtrap', token: config.MAILTRAP_API_TOKEN });
        }
        break;
      case 'mailpit':
        if (config.MAILPIT_API_URL) {
          targets.push({ kind: 'mailpit', baseUrl: config.MAILPIT_API_URL });
        }
        break;
      case 'smtp': {
        const target = legacySmtpTarget();
        if (target) targets.push(target);
        break;
      }
      default:
        break;
    }
  }
  return targets;
}

/**
 * Discrete SMTP_* variables, as GoTrue consumes them. Self-host installs
 * created before EMAIL_URL shipped carry a PLACEHOLDER quartet
 * (`localhost` / `unused` / `unused`) written by `kortix self-host init` so
 * GoTrue would boot with no relay. Treating that as a configured provider
 * would turn a clean `email_not_configured` skip into a connection-refused
 * failure on every invite, so it is explicitly not configured.
 */
function legacySmtpTarget(): EmailTarget | null {
  const host = (config.SMTP_HOST || '').trim();
  if (!host) return null;
  const user = (config.SMTP_USER || '').trim();
  const pass = (config.SMTP_PASS || '').trim();
  if (host === 'localhost' && user === 'unused' && pass === 'unused') return null;

  const port = Number(config.SMTP_PORT) || 587;
  const secure = port === 465;
  return {
    kind: 'smtp',
    host,
    port,
    secure,
    requireTls: !secure && Boolean(user || pass),
    rejectUnauthorized: true,
    ...(user ? { user } : {}),
    ...(pass ? { pass } : {}),
  };
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
  return resolveEmailChain().targets.map((target) => target.kind);
}

export function isEmailConfigured(): boolean {
  return resolveEmailChain().targets.length > 0;
}

/** The address every email is sent from, after EMAIL_FROM / legacy fallback. */
export function emailSender(): EmailAddress {
  return resolveEmailChain().from;
}

/** Operator-facing description of the chain, safe to log (no credentials). */
export function describeEmailChain(): string {
  const { targets, from } = resolveEmailChain();
  if (!targets.length) return 'email: not configured';
  return `email: ${targets.map((t) => t.kind).join(' → ')} as ${formatEmailAddress(from)}`;
}

function resolve(msg: EmailMessage, from: EmailAddress): ResolvedEmailMessage {
  return {
    ...msg,
    from: msg.from ?? from,
    // Every Kortix template supplies its own plain-text alternative, rendered
    // from the same structured content as the HTML (see template.ts). There is
    // deliberately no HTML-to-text fallback.
    text: msg.text ?? '',
  };
}

function dispatch(msg: ResolvedEmailMessage, target: EmailTarget): Promise<EmailSendResult> {
  switch (target.kind) {
    case 'smtp':
      return sendViaSmtp(msg, target);
    case 'resend':
      return sendViaResend(msg, target);
    case 'ses':
      return sendViaSes(msg, target);
    case 'mailtrap':
      return sendViaMailtrap(msg, target);
    case 'mailpit':
      return sendViaMailpit(msg, target);
  }
}

/**
 * Send one transactional email through the first provider in the configured
 * chain that accepts it. Never throws: network errors and non-2xx responses
 * fall through to the next provider; the last failure is returned when the
 * whole chain is exhausted.
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
  const { targets, from } = resolveEmailChain();
  if (targets.length === 0) {
    return { ok: false, skipped: true, reason: 'email_not_configured' };
  }

  const variants = applyLegacyResendSenderOverride(resolve(msg, from), targets);

  let lastFailure: EmailSendResult | null = null;
  for (const target of targets) {
    const resolved = target.kind === 'resend' ? variants.resend : variants.default;
    let result: EmailSendResult;
    try {
      result = await dispatch(resolved, target);
    } catch (err) {
      result = { ok: false, provider: target.kind, error: (err as Error).message };
    }
    if (result.ok) return result;
    console.warn(
      `[email] ${target.kind} send failed (${'status' in result && result.status ? result.status : 'network'}): ${'error' in result ? result.error : 'unknown'}`,
    );
    lastFailure = result;
  }
  return lastFailure as EmailSendResult;
}

/**
 * RESEND_FROM_EMAIL substitutes a verified sender on the Resend leg only, while
 * the intended address is preserved as Reply-To. It exists because the primary
 * from-domain is not verified in the Resend team; it applies to no other
 * provider, so the Resend variant of the message is built separately.
 */
function applyLegacyResendSenderOverride(
  msg: ResolvedEmailMessage,
  targets: EmailTarget[],
): { default: ResolvedEmailMessage; resend: ResolvedEmailMessage } {
  const override = (config.RESEND_FROM_EMAIL || '').trim();
  const usesResend = targets.some((target) => target.kind === 'resend');
  if (!override || !usesResend || override === msg.from.email) {
    return { default: msg, resend: msg };
  }
  return {
    default: msg,
    resend: {
      ...msg,
      from: { email: override, name: msg.from.name },
      replyTo: msg.replyTo ?? msg.from.email,
    },
  };
}
