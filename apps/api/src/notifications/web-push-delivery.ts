// Web Push delivery for one recipient (KRTX-1742). Placeholder until the Web
// Push sender lands: it sends nothing. The notifier calls it through
// `liveNotifierDeps().sendWebPush`, so replacing this body wires the channel.
import type { NotificationPushContent } from './push-payload';

export interface WebPushDeliveryInput {
  userId: string;
  accountId: string;
  content: NotificationPushContent;
}

export async function sendWebPushToUser(_input: WebPushDeliveryInput): Promise<{ sent: number }> {
  return { sent: 0 };
}
