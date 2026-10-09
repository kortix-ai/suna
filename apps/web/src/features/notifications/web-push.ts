/**
 * Web Push for this browser (KRTX-1742): the service worker (`public/sw.js`),
 * the push subscription, and its record on the API.
 *
 * `NotificationHost` calls `syncWebPush` whenever browser notifications are
 * turned on or off; sign-out calls `stopWebPush`. Nothing here toasts: a
 * failure is logged once, and the bell and in-page notifications still work.
 */

import { isDesktop } from '@/lib/desktop';
import { logger } from '@/lib/logger';
import { withTimeBudget } from '@/lib/utils/time-budget';
import {
  getWebPushPublicKey,
  registerWebPushSubscription,
  unregisterWebPushSubscription,
  type WebPushSubscriptionInput,
} from '@kortix/sdk';
import { isAllowedWebPushHost } from '@kortix/shared/notification-kinds';

/**
 * True where this renderer can receive Web Push. The desktop app is excluded:
 * Electron ships no push service, so `subscribe` rejects with an AbortError
 * ("push service not available").
 */
export function webPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    !isDesktop()
  );
}

/** Subscribe only when the person turned browser notifications on and the browser allows them. */
export function wantsWebPush(input: {
  supported: boolean;
  enabled: boolean;
  permission: NotificationPermission;
}): boolean {
  return input.supported && input.enabled && input.permission === 'granted';
}

/** The VAPID public key (base64url) as the bytes `pushManager.subscribe` takes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The three fields the API stores, or null when the browser left one out. */
export function subscriptionInput(json: PushSubscriptionJSON): WebPushSubscriptionInput | null {
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** The API refuses any other push host (400). Sending it would only fail. */
export function deliverable(input: WebPushSubscriptionInput): boolean {
  try {
    return isAllowedWebPushHost(new URL(input.endpoint).hostname);
  } catch {
    return false;
  }
}

function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!current || current.byteLength !== key.byteLength) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === key[index]);
}

let subscribed = false;

/**
 * True while the API holds this browser's subscription. A renderer without one
 * (the desktop app, a browser without Web Push) raises its own OS notifications
 * for new inbox rows instead.
 */
export function hasWebPushSubscription(): boolean {
  return subscribed;
}

/** How long a first-time worker may take to install and activate. */
const WORKER_ACTIVE_BUDGET_MS = 10_000;

let warned = false;
function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  logger.warn('[web-push] could not update this browser', { error: String(error) });
}

async function subscribe() {
  // Unknown until the API confirms. Until then this renderer raises its own
  // OS notifications for new inbox rows.
  subscribed = false;
  await navigator.serviceWorker.register('/sw.js');
  // `register` resolves while a first-time worker still installs, and
  // `subscribe` rejects without an active one. `ready` never settles when the
  // install fails, so a clock keeps the queue moving.
  const ready = await withTimeBudget(navigator.serviceWorker.ready, WORKER_ACTIVE_BUDGET_MS);
  if (ready.status !== 'settled') throw new Error('service worker not active');
  const registration = ready.value;
  const key = base64UrlToBytes((await getWebPushPublicKey()).public_key);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for another server key can never be delivered to.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const input = subscriptionInput(subscription.toJSON());
  if (!input || !deliverable(input)) return;
  // Every sync registers again: the API upserts by endpoint, so this also
  // moves a browser shared by two people to the one signed in now.
  await registerWebPushSubscription(input);
  subscribed = true;
}

async function unsubscribe() {
  subscribed = false;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await Promise.all([
    subscription.unsubscribe(),
    unregisterWebPushSubscription(subscription.endpoint),
  ]);
}

let queue: Promise<void> = Promise.resolve();

/**
 * Subscribe this browser (`want`) or remove its subscription. Calls run one at
 * a time, in call order. Never rejects.
 */
export function syncWebPush(want: boolean): Promise<void> {
  queue = queue.then(want ? subscribe : unsubscribe).catch(warnOnce);
  return queue;
}

/** Sign-out: the next person on this browser must not get this person's notifications. */
export function stopWebPush(): Promise<void> {
  return webPushSupported() ? syncWebPush(false) : Promise.resolve();
}
