/**
 * When the native splash hides (KRTX-244).
 *
 * The splash is the one loader at boot. It stays until the start route has
 * resolved — fonts loaded, auth known, and the landing decided — so the first
 * screen the user sees is the destination, never a second loader the splash
 * could have covered. A safety timeout hides it whatever is still loading;
 * the start screen then shows its own loader (`app/index.tsx`).
 *
 * `app/_layout.tsx` evaluates this and calls `SplashScreen.hideAsync()`; the
 * flags live in `stores/boot-store.ts`.
 */

/** The splash never stays longer than this, even if boot hangs. */
export const SPLASH_SAFETY_TIMEOUT_MS = 10_000;

/**
 * Routes that still decide or load where the user lands. `undefined` is the
 * start screen (`/`); `welcome` loads the plan before it shows or skips;
 * `+not-found` redirects to `/`.
 */
const LANDING_SEGMENTS = new Set<string | undefined>([undefined, 'welcome', '+not-found']);

export interface SplashGateInput {
  /** The splash is already hidden: hiding is one-shot. */
  splashHidden: boolean;
  /** `SPLASH_SAFETY_TIMEOUT_MS` passed since launch. */
  timedOut: boolean;
  fontsReady: boolean;
  authLoading: boolean;
  /** Signed in. Signed out, only the auth screen is a landing: a protected
   *  deep link must not flash before `AuthProtection` redirects to `/auth`. */
  authenticated: boolean;
  /** The first route segment on screen (`useSegments()[0]`). */
  segment: string | undefined;
  /** The start screen or the upgrade screen has something to show (not a loader). */
  landingSettled: boolean;
}

export function shouldHideSplash(input: SplashGateInput): boolean {
  if (input.splashHidden) return false;
  if (input.timedOut) return true;
  if (!input.fontsReady || input.authLoading) return false;
  if (!input.authenticated) return input.segment === 'auth';
  return !LANDING_SEGMENTS.has(input.segment) || input.landingSettled;
}
