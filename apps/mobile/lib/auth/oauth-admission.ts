/**
 * The login-only admission check for direct mobile OAuth (see mobile-admission.ts).
 *
 * One flag, armed per OAuth attempt and taken by the first SIGNED_IN event:
 *   arm      signInWithOAuth starts, or a callback whose stored state was
 *            minted by an OAuth attempt is consumed (callback-state.ts)
 *   disarm   the attempt ends without a session (cancel, timeout, error)
 *   take     SIGNED_IN reads and clears it; true → run the admission check
 *
 * The flag lives at module scope, not in a hook ref, because the Android
 * deep-link handler in app/_layout.tsx establishes the session outside the
 * hook. Before this, an Android attempt that gave up cleared the ref, and a
 * late callback signed in a brand-new OAuth account without the check.
 */
let armed = false;

export function armOAuthAdmission(): void {
  armed = true;
}

export function disarmOAuthAdmission(): void {
  armed = false;
}

export function takeOAuthAdmission(): boolean {
  const wasArmed = armed;
  armed = false;
  return wasArmed;
}
