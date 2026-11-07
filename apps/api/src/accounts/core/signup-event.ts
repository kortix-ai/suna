import { captureProductEvent } from '../../shared/product-analytics';
import { getSupabase } from '../../shared/supabase';

/** A sign-in this long after the auth user was created is not a sign-up. */
export const SIGNUP_EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Report `user_signed_up` for a person who reached Kortix with no workspace.
 *
 * WHY HERE. The event used to fire when the sign-in bootstrapped a personal
 * account. No account is created at sign-up any more (Workspaces D3), so the
 * event fires where that bootstrap ran: the first `GET /v1/accounts` (or
 * `/v1/accounts/me`) of a person with no membership, before pending invites
 * are claimed. Every client calls one of them right after sign-in, the
 * invited user included, and the Supabase auth hook is not ours on Kortix
 * cloud.
 *
 * ONCE PER PERSON. `dedupeKey: userId` gives the event a fixed uuid, and
 * PostHog keeps one event per uuid, so a repeat call by the same zero-account
 * person adds nothing. The window bounds the background work: a person whose
 * auth user is older than {@link SIGNUP_EVENT_WINDOW_MS} (an old user who left
 * every workspace) is not looked up again.
 *
 * Fire-and-forget: never awaited, never throws, never delays the request.
 */
export function reportSignupWithoutWorkspace(userId: string, now: () => number = Date.now): void {
  void (async () => {
    try {
      const { data } = await getSupabase().auth.admin.getUserById(userId);
      const user = data?.user;
      if (!user) return;
      const createdAt = user.created_at ? Date.parse(user.created_at) : Number.NaN;
      if (!Number.isFinite(createdAt) || now() - createdAt > SIGNUP_EVENT_WINDOW_MS) return;
      const provider = user.app_metadata?.provider;
      const method = typeof provider === 'string' && /^[a-z0-9_-]{1,32}$/.test(provider) ? provider : 'unknown';
      captureProductEvent({ userId, event: 'user_signed_up', dedupeKey: userId, properties: { method } });
    } catch {
      // Analytics only. A miss never affects the sign-in.
    }
  })();
}
