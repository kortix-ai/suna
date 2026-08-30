'use client';

import {
  isSigningOut,
  markSignOutStarted,
  runSignOut,
  SIGN_OUT_DESTINATION,
} from '@/lib/auth/sign-out-sequence';
import { finalizeServerSignOut } from '@/lib/auth/sign-out-actions';
import { createClient } from '@/lib/supabase/client';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { resetClientState } from '@/lib/utils/reset-client-state';

export { SIGN_OUT_DESTINATION };

/**
 * The ONE sign-out in the product. Every logout control calls this.
 *
 * The navigation is a DOCUMENT LOAD, deliberately, and not `router.push` /
 * `router.replace`. An identity change must not carry a single byte of the
 * previous user's rendering across, and a soft navigation carries three caches
 * that `resetClientState()` cannot reach:
 *
 *  - the App Router ROUTE CACHE, holding rendered RSC payloads for visited
 *    segments. `router.refresh()` does not clear it — only Next's internal
 *    `invalidateEntirePrefetchCache` does, which no application code can call;
 *  - the SEGMENT CACHE of prefetched payloads, which `staleTimes` bounds but
 *    does not empty;
 *  - BFCACHE, whose restores bypass staleness entirely, so no `staleTimes`
 *    value can substitute.
 *
 * The sign-IN side adopted `window.location.assign` for the same reason
 * (`(auth)/auth/page.tsx`, `establishSessionAndRedirect`).
 *
 * The sequence itself, and what each failure is allowed to prevent, lives in
 * `sign-out-sequence.ts`.
 */
/**
 * Expire this browser's Supabase auth cookie, chunks included.
 *
 * `@supabase/ssr` splits a session that outgrows the ~4KB cookie limit across
 * `<name>.0`, `<name>.1`, … so clearing only the base name leaves a signed-in
 * browser whenever the JWT is large — which is the normal case once a user
 * carries app metadata. Every variant is expired, at the same `path: '/'` the
 * client writes them with (`lib/supabase/client.ts`, `cookieOptions`); a
 * mismatched path silently expires nothing.
 *
 * Not `httpOnly`, by design in `@supabase/ssr` — the browser client has to read
 * it — which is exactly what makes this possible from here.
 */
function expireSupabaseAuthCookie(): void {
  const names = [
    KORTIX_SUPABASE_AUTH_COOKIE,
    // Generous: `@supabase/ssr` has never needed more than a couple of chunks,
    // and expiring a cookie that does not exist costs nothing.
    ...Array.from({ length: 6 }, (_, index) => `${KORTIX_SUPABASE_AUTH_COOKIE}.${index}`),
  ];

  for (const name of names) {
    document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
  }
}

/**
 * The ONE sign-out in the product. Every logout control calls this.
 *
 * Re-entrant by refusal, not by queueing. The bounded sequence below can take
 * several seconds when the network is broken, which is long enough for a user
 * to press Log out again; a second pass would re-issue every request and race
 * the first one's navigation. The first call owns the exit.
 */
export async function performSignOut(): Promise<void> {
  if (isSigningOut()) return;

  // Before the first await, and before anything that can throw. Signed-out
  // route guards read `isSigningOut()` (see `useSignedOutRedirect`) so a
  // `SIGNED_OUT` event cannot fire their soft `router.replace('/auth')` while
  // this document load is still being set up — a soft navigation there would
  // reach `/auth` with the App Router route cache intact, which is the exact
  // defect this whole path exists to remove.
  markSignOutStarted();

  let left = false;
  try {
    const supabase = createClient();
    await runSignOut({
      finalizeServerSession: finalizeServerSignOut,
      endSession: (scope) => (scope ? supabase.auth.signOut({ scope }) : supabase.auth.signOut()),
      resetClientState,
      dropAuthCookie: expireSupabaseAuthCookie,
      leave: (destination) => {
        left = true;
        // `@next/next/no-location-assign-relative-destination` inspects string
        // LITERALS, so it does not fire on this identifier — that is a property
        // of the rule, not an exemption taken here. The document load is the
        // fix, and it is what the rule would be waved through for.
        window.location.assign(destination);
      },
    });
  } finally {
    // `runSignOut` cannot fail to leave, but everything BEFORE it can:
    // `createClient()` throws synchronously when the runtime env is
    // unparseable (`lib/supabase/client.ts`). Callers say `void
    // performSignOut()`, so that throw would strand a user who has already
    // tripped the in-flight latch, on a page whose guard now stands down for
    // them. The invariant is "a sign-out always leaves", from any state of the
    // world — so the exit is in a `finally`, taken only if the sequence did not
    // already take it.
    if (!left) {
      window.location.assign(SIGN_OUT_DESTINATION);
    }
  }
}
