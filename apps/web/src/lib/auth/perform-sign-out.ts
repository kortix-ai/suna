'use client';

import { finalizeServerSignOut } from '@/lib/auth/sign-out-actions';
import { stashSignOutNotice } from '@/lib/auth/sign-out-notice';
import { runSignOut, SIGN_OUT_DESTINATION } from '@/lib/auth/sign-out-sequence';
import { createClient } from '@/lib/supabase/client';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { resetClientState } from '@/lib/utils/reset-client-state';

export { SIGN_OUT_DESTINATION };

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
 * Where a sign-out lands: `/auth`, or `/auth?returnUrl=<path>` so the next
 * sign-in comes back to `returnUrl`. Same-origin paths only: anything else is
 * dropped, so a caller can never turn sign-out into an open redirect.
 */
export function signOutDestination(returnUrl?: string): string {
  if (!returnUrl || !returnUrl.startsWith('/') || returnUrl.startsWith('//') || returnUrl.includes('\\')) {
    return SIGN_OUT_DESTINATION;
  }
  return `${SIGN_OUT_DESTINATION}?returnUrl=${encodeURIComponent(returnUrl)}`;
}

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
 * Re-entry is refused by `runSignOut`, not here — a second press must never
 * start a second sequence, but it must always still navigate. See `runSignOut`
 * for why a user can genuinely press Log out twice.
 *
 * The sequence itself, and what each failure is allowed to prevent, lives in
 * `sign-out-sequence.ts`.
 */
export async function performSignOut(options?: { returnUrl?: string }): Promise<void> {
  const destination = signOutDestination(options?.returnUrl);
  let left = false;
  try {
    const supabase = createClient();
    await runSignOut({
      finalizeServerSession: finalizeServerSignOut,
      endSession: (scope) => (scope ? supabase.auth.signOut({ scope }) : supabase.auth.signOut()),
      resetClientState,
      dropAuthCookie: expireSupabaseAuthCookie,
      // The toast cannot live in THIS document (`leave` replaces it), so the
      // notice is stashed for the `/auth` document that follows.
      notifySignOutIncomplete: stashSignOutNotice,
      leave: (target) => {
        left = true;
        // `@next/next/no-location-assign-relative-destination` inspects string
        // LITERALS, so it does not fire on this identifier — that is a property
        // of the rule, not an exemption taken here. The document load is the
        // fix, and it is what the rule would be waved through for.
        window.location.assign(target === SIGN_OUT_DESTINATION ? destination : target);
      },
    });
  } finally {
    // `runSignOut` cannot fail to leave, but everything BEFORE it can:
    // `createClient()` throws synchronously when the runtime env is
    // unparseable (`lib/supabase/client.ts`). Callers say `void
    // performSignOut()`, so that throw would strand the user. The invariant is
    // "a sign-out always leaves", from any state of the world.
    //
    // The cookie goes with it. This path never reached `runSignOut`, so
    // `dropAuthCookie()` was never called — and landing on `/auth` with a live
    // session is exactly the bounce-straight-back-in symptom the whole
    // `dropAuthCookie` step exists to prevent.
    if (!left) {
      expireSupabaseAuthCookie();
      window.location.assign(destination);
    }
  }
}
