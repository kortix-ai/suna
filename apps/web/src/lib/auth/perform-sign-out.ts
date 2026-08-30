'use client';

import { runSignOut, SIGN_OUT_DESTINATION } from '@/lib/auth/sign-out-sequence';
import { finalizeServerSignOut } from '@/lib/auth/sign-out-actions';
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
export async function performSignOut(): Promise<void> {
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
    // performSignOut()`, so that throw would strand the user. The invariant is
    // "a sign-out always leaves", from any state of the world.
    //
    // The cookie goes with it. This path never reached `runSignOut`, so
    // `dropAuthCookie()` was never called — and landing on `/auth` with a live
    // session is exactly the bounce-straight-back-in symptom the whole
    // `dropAuthCookie` step exists to prevent.
    if (!left) {
      expireSupabaseAuthCookie();
      window.location.assign(SIGN_OUT_DESTINATION);
    }
  }
}
