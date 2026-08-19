import type { EmailTargetKind } from '@kortix/shared/email-url';

/** Provider that actually accepted (or rejected) a send. */
export type EmailProvider = EmailTargetKind;

export interface EmailAddress {
  email: string;
  name: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  /** Plain-text alternative. Derived from `html` when omitted. */
  text?: string;
  /** Provider-side label for the send (SES tag / Resend tag / Mailtrap category). */
  category: string;
  /** Defaults to the transport's configured sender (EMAIL_FROM). */
  from?: EmailAddress;
  replyTo?: string;
}

export type EmailSendResult =
  | { ok: true; provider: EmailProvider; status: number }
  | { ok: false; skipped: true; reason: 'email_not_configured' }
  | {
      ok: false;
      skipped?: false;
      provider: EmailProvider;
      status?: number;
      error: string;
    };

/** A message with every default already applied, as handed to a provider. */
export interface ResolvedEmailMessage extends EmailMessage {
  from: EmailAddress;
  text: string;
}

export const EMAIL_SEND_TIMEOUT_MS = 10_000;
