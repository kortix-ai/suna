// Web Push subscriptions (KRTX-1742). STUB(KRTX-1742 WP-C): replaced by the
// channels work package.

export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type WebPushSubscriptionValidation =
  | { ok: true }
  | { ok: false; error: 'unsupported_push_service' | 'invalid_endpoint' | 'invalid_keys' };

/** https, no userinfo, no port, a known push service host, valid key lengths. */
export function validateWebPushSubscriptionInput(_input: WebPushSubscriptionInput): WebPushSubscriptionValidation {
  return { ok: false, error: 'unsupported_push_service' };
}

/** Upsert by endpoint for `userId` (reassigns a reused endpoint); keeps at most 10 per user. */
export async function registerWebPushSubscription(_input: WebPushSubscriptionInput & {
  userId: string;
  authSessionId: string;
  aal: string;
}): Promise<void> {}

/** Delete the caller's own row. True when a row was deleted. */
export async function deleteWebPushSubscription(_userId: string, _endpoint: string): Promise<boolean> {
  return false;
}

/** A sign-in ended (device sign-out): drop its subscriptions. */
export async function deleteWebPushSubscriptionsForSignIn(_authSessionId: string): Promise<number> {
  return 0;
}

/** Account erasure: drop every subscription of the user. */
export async function deleteWebPushSubscriptionsForUser(_userId: string): Promise<number> {
  return 0;
}
