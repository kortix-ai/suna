import { type BudgetOutcome, withTimeBudget } from '@/lib/utils/time-budget';

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

/**
 * How long each step may hold up the exit, in milliseconds. Worst case is their
 * SUM — 6.0s — because the local retry is skipped in the only case that could
 * make all three run long (see `runSignOut`).
 *
 * They are not the same number, and the differences are load-bearing:
 *
 *  - **3000 for the server revoke**, matching `finalizeServerSignOut`'s own
 *    `AbortSignal.timeout(3_000)`. A tighter outer bound would mean that inner
 *    abort could never fire while anyone waits, and — because `withTimeBudget`
 *    does not CANCEL anything — the request would only land at all because the
 *    remaining steps happen to keep the document alive long enough. That is
 *    accidental coupling: every second cut from the tail would silently remove
 *    grace from an in-flight revoke. Equal budgets make the guarantee explicit.
 *  - **2000 for the sign-out**, the one step whose success is the whole point.
 *  - **1000 for the reset**, which is generous rather than tight:
 *    `clearSessionIDBCache` issues `tx.objectStore(STORE_NAME).clear()` and
 *    returns WITHOUT awaiting the transaction, so the only awaited work is
 *    `openDB()`. Cache size is irrelevant — a 10-entry and a 10,000-entry cache
 *    settle identically, and the only thing 1000ms is really waiting out is the
 *    blocked-upgrade hang that has no upper bound at all.
 */
export const SIGN_OUT_BUDGETS_MS = {
  finalizeServerSession: 3_000,
  endSession: 2_000,
  resetClientState: 1_000,
} as const;

export type SignOutBudgets = { -readonly [K in keyof typeof SIGN_OUT_BUDGETS_MS]: number };

/**
 * The result shape `supabase.auth.signOut()` returns.
 *
 * `name` is read, not decoration: it is how a NETWORK-class failure is told
 * apart from an HTTP one. `@supabase/auth-js` tags the former
 * `AuthRetryableFetchError` (`lib/errors.js`), and only that distinction makes
 * the retry decision below correct rather than superstitious.
 */
type SignOutResult = { error: { message?: string; name?: string; status?: number } | null };

/** The four things a sign-out does, injected so the order and the failure handling can be tested. */
export type SignOutSteps = {
  /**
   * The server half: revoke the session in the API's activity table, emit the
   * audit event, and clear the httpOnly auth-bounce cookie. FIRST, because it
   * authenticates with the access token the next step throws away.
   */
  finalizeServerSession: () => Promise<void>;
  /**
   * `supabase.auth.signOut()`.
   *
   * `scope: 'local'` is NOT a local-only operation, despite the name — see
   * `dropAuthCookie` for what that costs and how it is covered.
   */
  endSession: (scope?: 'local') => Promise<SignOutResult>;
  /**
   * Expire this browser's Supabase auth cookie by hand.
   *
   * The last line of defence, and it exists because BOTH `endSession()` calls
   * can leave the session in place. In `@supabase/auth-js@2.110.0`,
   * `GoTrueClient._signOut()` posts to `/logout` for EVERY scope — `'local'`
   * included — and on an error that is not 404/401/403 it returns BEFORE
   * `_removeSession()`. Offline and 5xx produce `AuthRetryableFetchError` and
   * `AuthApiError(500)`, neither of which is in that list, so the session
   * survives, no `SIGNED_OUT` fires, and `resetClientState()` does not touch it
   * either (`clearUserLocalStorage` only sweeps this app's own storage-key
   * prefixes, never a cookie).
   *
   * `leave('/auth')` then loads `/auth`, where `AuthContent` reads the still
   * valid session, computes `trustedUser`, and redirects straight back into the
   * app. The user waited the full budget and is NOT signed out, with no error
   * shown. This is the one step that makes "signed out on this browser" true
   * regardless of what any server said: the cookie is not `httpOnly`, so the
   * document can expire it itself.
   */
  dropAuthCookie: () => void;
  /** React Query, the account store, per-user localStorage, the IDB cache. */
  resetClientState: () => Promise<void>;
  /** A DOCUMENT navigation. Never `router.push` — see `performSignOut`. */
  leave: (destination: string) => void;
};

/**
 * Whether a sign-out has begun in this document.
 *
 * Latched, and never cleared in production: the sign-out ends on a document
 * load, so "we are leaving" stays true until this document is gone. The signed-
 * out route guard reads it so it does not race the exit — see
 * `useSignedOutRedirect`.
 */
let signOutStarted = false;

/** True once a sign-out is in flight in this document. */
export function isSigningOut(): boolean {
  return signOutStarted;
}

/**
 * TEST ONLY. Production never clears the latch, so a test file that runs more
 * than one sign-out has to. Named to be unmistakable in a diff; a source
 * assertion pins that nothing outside a test calls it.
 */
export function __resetSignOutLatchForTests(): void {
  signOutStarted = false;
}

/**
 * Run one sign-out.
 *
 * Four properties this holds that no previous logout path did:
 *
 *  1. **The error is READ, and the session is ENDED even when reading it is not
 *     enough.** `signOut()` returns `{ error }` rather than throwing, and every
 *     previous caller dropped it. On that path Supabase removed no session,
 *     fired no `SIGNED_OUT`, and cleared nothing — and the user was navigated to
 *     `/auth` as though it had worked, where the still live session sent them
 *     straight back into the app.
 *
    Reading the error buys a retry with `scope: 'local'`, and that retry is
 *     worth taking — but it is NOT the guarantee it looks like. `scope: 'local'`
 *     still posts to `/logout` and still bails before removing the session on a
 *     non-404/401/403 error, so offline and 5xx defeat both calls. The
 *     guarantee comes from `dropAuthCookie()`, which runs whenever the session
 *     is not PROVEN gone: a returned error, a thrown fetch, or a timeout, on
 *     either attempt.
 *
 *     The retry is SKIPPED when the first attempt already proved the network is
 *     the problem — a timeout, or a settled `AuthRetryableFetchError` — because
 *     `scope: 'local'` makes the same request to the same host and can only
 *     fail the same way, one budget later. It is KEPT for any settled HTTP
 *     error: `scope: 'global'` revokes every refresh token for the user, which
 *     is a heavier server write than `scope: 'local'`, so a global 500 beside a
 *     local 200 is not hypothetical.
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
 *  4. **Nothing is stranded, and a SECOND press still leaves.** `/new`'s button
 *     neither awaited nor navigated, so it signed the user out and left them on
 *     the create form. The re-entry branch below is the other half of that: it
 *     refuses to run a second sequence but still navigates, because a user can
 *     genuinely end up back here — press Log out with unsaved file edits open
 *     and the `beforeunload` prompt lets them press "Stay"
 *     (`file-viewer/file-content-renderer.tsx`). Returning silently left them
 *     signed out, inside the app, with a permanently disabled button and a
 *     route guard that had already stood down.
 *
 * Worst case before `leave()` is 6.0s: the sum of the three budgets, since the
 * only case that makes all of them run long — everything hanging — is exactly
 * the case that skips the retry.
 */
export async function runSignOut(
  steps: SignOutSteps,
  { budgets = SIGN_OUT_BUDGETS_MS }: { budgets?: SignOutBudgets } = {},
): Promise<void> {
  if (signOutStarted) {
    // Never a second sequence; ALWAYS a navigation.
    steps.leave(SIGN_OUT_DESTINATION);
    return;
  }
  // Before the first await, so a `SIGNED_OUT` fired inside `endSession` cannot
  // beat the guard's stand-down.
  signOutStarted = true;

  const server = await withTimeBudget(
    steps.finalizeServerSession(),
    budgets.finalizeServerSession,
  );
  if (server.status !== 'settled') {
    // Best effort. A backend that is down — or merely slow — must never be able
    // to keep a user signed in.
    console.error('[signOut] server-side sign-out did not complete:', server);
  }

  const ended = await withTimeBudget(steps.endSession(), budgets.endSession);
  let sessionRemoved = ended.status === 'settled' && !ended.value.error;

  if (!sessionRemoved && !isNetworkClassFailure(ended)) {
    console.error('[signOut] server sign-out failed, retrying locally:', ended);
    const local = await withTimeBudget(steps.endSession('local'), budgets.endSession);
    sessionRemoved = local.status === 'settled' && !local.value.error;
    if (!sessionRemoved) {
      console.error('[signOut] local sign-out also failed:', local);
    }
  } else if (!sessionRemoved) {
    console.error('[signOut] sign-out failed at the network; not retrying:', ended);
  }

  // PROVEN gone, or take it away ourselves. Nothing below this line can tell
  // the difference between "Supabase removed the session" and "Supabase
  // returned early and left it there", so the only safe reading of anything
  // other than a clean result is that the session is still live.
  if (!sessionRemoved) {
    steps.dropAuthCookie();
  }

  const reset = await withTimeBudget(steps.resetClientState(), budgets.resetClientState);
  if (reset.status !== 'settled') {
    console.error('[signOut] client-state reset did not complete:', reset);
  }

  // Again, immediately before leaving. When the session was never removed,
  // auth-js still holds it in memory with `autoRefreshToken` ticking, and a
  // refresh — or a visibility-change `_recoverAndRefresh` — writes it straight
  // back into the cookie through `storage.setItem`. The window is small (~1s
  // against a 30s tick) and the fix is one line.
  if (!sessionRemoved) {
    steps.dropAuthCookie();
  }

  steps.leave(SIGN_OUT_DESTINATION);
}

/**
 * Whether the first sign-out attempt already proved the NETWORK is the problem,
 * which makes a second identical request to the same host pointless.
 *
 * Two shapes count. A `timeout` carries no error to classify — the request is
 * still in flight, and re-issuing it only buys another full budget of waiting.
 * A settled `AuthRetryableFetchError` is auth-js's own tag for "the fetch did
 * not complete" (`@supabase/auth-js/dist/main/lib/errors.js`), which is what
 * offline and DNS failures produce.
 *
 * Everything else — any settled HTTP error, and a throw — falls through to the
 * retry on purpose. `scope: 'global'` revokes every refresh token for the user
 * and is a heavier server write than `scope: 'local'`, so a global failure
 * beside a local success is a real outcome, not a theoretical one.
 */
function isNetworkClassFailure(outcome: BudgetOutcome<SignOutResult>): boolean {
  if (outcome.status === 'timeout') return true;
  return outcome.status === 'settled' && outcome.value.error?.name === 'AuthRetryableFetchError';
}
