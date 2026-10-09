// Email delivery for notifications (KRTX-1742). STUB(KRTX-1742 WP-C): placeholder until the email
// channel lands: it sends nothing. The notifier calls it through
// `liveNotifierDeps().sendEmailNow`, so replacing these bodies wires email.
import type { NotificationKindName } from '@kortix/shared/notification-kinds';

export interface ImmediateEmailInput {
  notificationId: string;
  userId: string;
  accountId: string;
  kind: NotificationKindName;
  title: string;
  body: string;
  url: string;
}

/** True when this deployment can send email at all. */
export function isNotificationEmailAvailable(): boolean {
  return false;
}

/** Send one notification email now. 'skipped' when nothing was sent on purpose. */
export async function sendImmediateNotificationEmail(_input: ImmediateEmailInput): Promise<'sent' | 'skipped' | 'failed'> {
  return 'skipped';
}
