/**
 * The sign-out SEQUENCE: what happens, in what order, and what a failure at
 * each step is allowed to prevent.
 *
 * Split from `perform-sign-out.ts` — which supplies the real steps — because
 * the wiring reaches a `'use server'` module and the browser Supabase client,
 * and neither belongs in the module that states the rule.
 */

/**
 * Where a sign-out lands. Not configurable on purpose: every logout control in
 * the product ends on the same screen, and a caller-supplied destination is how
 * six controls grew four different behaviours in the first place.
 */
export const SIGN_OUT_DESTINATION = '/auth';

/** The result shape `supabase.auth.signOut()` returns. */
type SignOutResult = { error: { message?: string } | null };

/** The four things a sign-out does, injected so the order and the failure handling can be tested. */
export type SignOutSteps = {
  /**
   * The server half: revoke the session in the API's activity table, emit the
   * audit event, and clear the httpOnly auth-bounce cookie. FIRST, because it
   * authenticates with the access token the next step throws away.
   */
  finalizeServerSession: () => Promise<void>;
  /** `supabase.auth.signOut()`. `scope: 'local'` skips the server entirely. */
  endSession: (scope?: 'local') => Promise<SignOutResult>;
  /** React Query, the account store, per-user localStorage, the IDB cache. */
  resetClientState: () => Promise<void>;
  /** A DOCUMENT navigation. Never `router.push` — see `performSignOut`. */
  leave: (destination: string) => void;
};

/**
 * Run one sign-out.
 *
 * Three properties this holds that no previous logout path did:
 *
 *  1. **The error is READ.** `signOut()` returns `{ error }` rather than
 *     throwing, and every previous caller dropped it. On that path Supabase
 *     removed no session, fired no `SIGNED_OUT`, and cleared nothing — and the
 *     user was navigated to `/auth` as though it had worked, where the still
 *     live session sent them straight back into the app. The retry with
 *     `scope: 'local'` is what actually fixes it: the common failures are "the
 *     server could not revoke it" (offline, 5xx, an already-rotated refresh
 *     token), and a local sign-out drops the session from this browser without
 *     asking the server for permission.
 *  2. **The cleanup runs REGARDLESS.** `resetClientState()` is not conditional
 *     on the sign-out succeeding. The `SIGNED_OUT` listener in `AuthProvider`
 *     also resets, but it only fires when Supabase actually removed a session —
 *     which is exactly the case that already worked.
 *  3. **Leaving ALWAYS happens.** Every step is guarded, so a thrown cleanup
 *     cannot strand a signed-out user on an authenticated screen — which is
 *     what `/new`'s button did, since it neither awaited nor navigated.
 */
export async function runSignOut(steps: SignOutSteps): Promise<void> {
  try {
    await steps.finalizeServerSession();
  } catch (error) {
    // Best effort. A backend that is down must never keep a user signed in.
    console.error('[signOut] server-side sign-out failed:', error);
  }

  try {
    const { error } = await steps.endSession();
    if (error) {
      console.error('[signOut] server sign-out failed, retrying locally:', error.message);
      const local = await steps.endSession('local');
      if (local.error) {
        console.error('[signOut] local sign-out also failed:', local.error.message);
      }
    }
  } catch (error) {
    console.error('[signOut] sign-out threw:', error);
  }

  try {
    await steps.resetClientState();
  } catch (error) {
    console.error('[signOut] failed to reset client state:', error);
  }

  steps.leave(SIGN_OUT_DESTINATION);
}
