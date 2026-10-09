// Web Push delivery for one recipient (KRTX-1742): every browser the user
// subscribed from, while its sign-in lives. An account that requires MFA
// gets no push on a browser that registered at aal1. The notifier calls this
// through `liveNotifierDeps().sendWebPush`.
import { eq } from 'drizzle-orm';
import { accounts } from '@kortix/db';
import { db } from '../shared/db';
import { clip, INBOX_BODY_MAX_CHARS, INBOX_TITLE_MAX_CHARS } from './inbox-store';
import type { NotificationPushContent } from './push-payload';
import { getVapidKeyPair } from './vapid-keys';
import { sendWebPushMessage, type PushFetch } from './web-push';
import { deleteWebPushEndpoints, listDeliverableWebPushSubscriptions } from './web-push-subscriptions';

export interface WebPushDeliveryInput {
  userId: string;
  accountId: string;
  content: NotificationPushContent;
}

/** What the service worker receives: what to show, and what a click opens. */
export interface WebPushMessageBody extends Record<string, unknown> {
  title: string;
  body: string;
  /** `<type>:<sessionId|triggerSlug>`: a newer push for the subject replaces the older one, in-page alerts included. */
  tag: string;
  url: string;
  notificationId: string;
}

const URGENT_KINDS = new Set(['question', 'permission', 'automation_failed']);

export function webPushMessageBody(content: NotificationPushContent): WebPushMessageBody {
  const { payload } = content;
  return {
    ...payload,
    title: clip(content.title, INBOX_TITLE_MAX_CHARS),
    body: clip(content.body, INBOX_BODY_MAX_CHARS),
    tag: `${payload.type}:${payload.sessionId ?? payload.triggerSlug ?? payload.notificationId}`,
  };
}

async function accountRequiresMfa(accountId: string): Promise<boolean> {
  const [row] = await db.select({ mfaRequired: accounts.mfaRequired }).from(accounts).where(eq(accounts.accountId, accountId));
  return row?.mfaRequired === true;
}

export async function sendWebPushToUser(
  input: WebPushDeliveryInput,
  deps: { fetch?: PushFetch } = {},
): Promise<{ sent: number }> {
  const subscriptions = await listDeliverableWebPushSubscriptions(input.userId);
  if (subscriptions.length === 0) return { sent: 0 };
  const targets = (await accountRequiresMfa(input.accountId))
    ? subscriptions.filter((row) => row.aal === 'aal2')
    : subscriptions;
  if (targets.length === 0) return { sent: 0 };

  const vapid = await getVapidKeyPair();
  const payload = JSON.stringify(webPushMessageBody(input.content));
  const urgency = URGENT_KINDS.has(input.content.payload.kind) ? 'high' : 'normal';
  const results = await Promise.all(
    targets.map((target) => sendWebPushMessage(target, payload, { vapid, urgency, fetch: deps.fetch })),
  );
  // Gone at the push service, or no longer a push service URL: never send there again.
  await deleteWebPushEndpoints(
    targets.filter((_, i) => results[i]!.outcome === 'gone' || results[i]!.outcome === 'refused').map((t) => t.endpoint),
  );
  return { sent: results.filter((r) => r.outcome === 'sent').length };
}
