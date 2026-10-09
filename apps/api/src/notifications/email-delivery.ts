// Email delivery for notifications (KRTX-1742): one email to one user, through
// the platform transport. The notifier calls `sendImmediateNotificationEmail`
// (automation kinds); the notification worker calls
// `sendNotificationDigestEmail`. Never throws.
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import { lookupEmailsByUserIds } from '../accounts/core/owner-emails';
import { isEmailConfigured, sendEmail } from '../lib/email/transport';
import type { EmailSendResult } from '../lib/email/types';
import { logger } from '../lib/logger';
import {
  renderImmediateNotificationEmail,
  renderNotificationDigestEmail,
  type NotificationEmailItem,
  type RenderedEmail,
} from './notification-email';

export const IMMEDIATE_EMAIL_CATEGORY = 'notification-automation-alert';
export const DIGEST_EMAIL_CATEGORY = 'notification-digest';

export type NotificationEmailOutcome = 'sent' | 'skipped' | 'failed';

export interface ImmediateEmailInput {
  notificationId: string;
  userId: string;
  accountId: string;
  kind: NotificationKindName;
  title: string;
  body: string;
  url: string;
}

let send = sendEmail;

/** Capture notification emails in a test; `null` restores the real transport. */
export function setNotificationEmailSenderForTest(sender: typeof sendEmail | null): void {
  send = sender ?? sendEmail;
}

/** True when this deployment can send email at all. */
export function isNotificationEmailAvailable(): boolean {
  return isEmailConfigured();
}

/** 'skipped': nothing to send to (no address, a reserved test domain, no provider). */
function outcomeOf(result: EmailSendResult): NotificationEmailOutcome {
  if (result.ok) return 'sent';
  return result.skipped ? 'skipped' : 'failed';
}

async function sendToUser(userId: string, category: string, rendered: RenderedEmail): Promise<NotificationEmailOutcome> {
  try {
    const to = (await lookupEmailsByUserIds([userId])).get(userId);
    if (!to) return 'skipped';
    const outcome = outcomeOf(await send({ ...rendered, to: [to], category }));
    if (outcome === 'failed') logger.warn('[notify] email send failed', { category, userId });
    return outcome;
  } catch (error) {
    logger.warn('[notify] email send failed', { category, userId, error: error instanceof Error ? error.message : String(error) });
    return 'failed';
  }
}

/** Send one automation alert email now. 'skipped' when nothing was sent on purpose (any other kind included). */
export async function sendImmediateNotificationEmail(input: ImmediateEmailInput): Promise<NotificationEmailOutcome> {
  const rendered = renderImmediateNotificationEmail(input);
  return rendered ? sendToUser(input.userId, IMMEDIATE_EMAIL_CATEGORY, rendered) : 'skipped';
}

/** One digest email listing `items` (at most 10) and a count of the rest. */
export function sendNotificationDigestEmail(input: {
  userId: string;
  items: readonly NotificationEmailItem[];
  more: number;
}): Promise<NotificationEmailOutcome> {
  return sendToUser(input.userId, DIGEST_EMAIL_CATEGORY, renderNotificationDigestEmail(input));
}
