import { DEFAULT_TIME_BUDGET_MS, withTimeBudget } from '@/lib/utils/time-budget';

/**
 * The sign-out SEQUENCE: what happens, in what order, what a failure at each
 * step is allowed to prevent, and how long any step may hold up the exit.
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
 * Whether a sign-out has begun in this document.
 *
 * Latched, never cleared: the sign-out ends on a document load, so "we are
 * leaving" is true until this document is gone. Signed-out route guards read it
 * so they do not race the exit — see `NewWorkspacePage` and `ProjectStartPage`.
 */
let signOutStarted = false;

/** Called by `performSignOut` the instant a user asks to leave. */
export function markSignOutStarted(): void {
  signOutStarted = true;
}

/** True once a sign-out is in flight in this document. */
export function isSigningOut(): boolean {
  return signOutStarted;
}

/**
 * Run one sign-out.
 *
 * Four properties this holds that no previous logout path did:
 *
 *  1. **The error is READ.** `signOut()` returns `{ error }` rather than
 *     throwing, and every previous caller dropped it. On that path Supabase
 *     removed no session, fired no `SIGNED_OUT`, and cleared nothing — and the
 *     user was navigated to `/auth` as though it had worked, where the still
 *     live session sent them straight back into the app. The retry with
 *     `scope: 'local'` is what actually fixes it: every non-clean outcome —
 *     a returned error, a thrown fetch, or a timeout — means "the server would
 *     not revoke it", and a local sign-out drops the session from this browser
 *     without asking the server for permission.
 *  2. **The cleanup runs REGARDLESS.** `resetClientState()` is not conditional
 *     on the sign-out succeeding. The `SIGNED_OUT` listener in `AuthProvider`
 *     also resets, but it only fires when Supabase actually removed a session —
 *     which is exactly the case that already worked.
 *  3. **Leaving ALWAYS happens, on a WALL CLOCK.** Every step is bounded, not
 *     just guarded. A `try`/`catch` cannot rescue a promise that never settles,
 *     and one of these steps can genuinely hang forever: `resetClientState()`
 *     awaits `clearSessionIDBCache()`, whose `openDB()` has no `onblocked`
 *     handler, so a version upgrade blocked by a stale tab never resolves.
 *     Unbounded, the user could not sign out at all and saw no error.
 *
 *     Bounding is safe for a reason specific to this sequence: everything
 *     identity-critical in `resetClientState()` is SYNCHRONOUS and complete
 *     before its one awaited call — the React Query cache, the persisted
 *     account selection and the per-user localStorage are already gone. Only
 *     the IndexedDB purge can be outrun, and those entries are keyed
 *     `user:<id>` (`buildSessionCacheKey`), so the next account cannot read
 *     them.
 *  4. **Nothing is stranded.** `/new`'s button neither awaited nor navigated,
 *     so it signed the user out and left them on the create form.
 *
 * Worst case before `leave()` is four budgets. In practice the local retry is
 * pure storage and returns in ~0ms even when every network call is dead, so a
 * fully broken environment exits in about three.
 */
export async function runSignOut(
  steps: SignOutSteps,
  { stepTimeoutMs = DEFAULT_TIME_BUDGET_MS }: { stepTimeoutMs?: number } = {},
): Promise<void> {
  const server = await withTimeBudget(steps.finalizeServerSession(), stepTimeoutMs);
  if (server.status !== 'settled') {
    // Best effort. A backend that is down — or merely slow — must never be able
    // to keep a user signed in.
    console.error('[signOut] server-side sign-out did not complete:', server);
  }

  const ended = await withTimeBudget(steps.endSession(), stepTimeoutMs);
  const cleanlyEnded = ended.status === 'settled' && !ended.value.error;
  if (!cleanlyEnded) {
    console.error('[signOut] server sign-out failed, retrying locally:', ended);
    const local = await withTimeBudget(steps.endSession('local'), stepTimeoutMs);
    if (local.status !== 'settled' || local.value.error) {
      console.error('[signOut] local sign-out also failed:', local);
    }
  }

  const reset = await withTimeBudget(steps.resetClientState(), stepTimeoutMs);
  if (reset.status !== 'settled') {
    console.error('[signOut] client-state reset did not complete:', reset);
  }

  steps.leave(SIGN_OUT_DESTINATION);
}
