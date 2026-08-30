'use client';

import { runSignOut, SIGN_OUT_DESTINATION } from '@/lib/auth/sign-out-sequence';
import { finalizeServerSignOut } from '@/lib/auth/sign-out-actions';
import { createClient } from '@/lib/supabase/client';
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
export async function performSignOut(): Promise<void> {
  const supabase = createClient();
  await runSignOut({
    finalizeServerSession: finalizeServerSignOut,
    endSession: (scope) => (scope ? supabase.auth.signOut({ scope }) : supabase.auth.signOut()),
    resetClientState,
    leave: (destination) => {
      // `@next/next/no-location-assign-relative-destination` inspects string
      // LITERALS, so it does not fire on this identifier — that is a property of
      // the rule, not an exemption taken here. The document load is the fix, and
      // it is what the rule would be waved through for.
      window.location.assign(destination);
    },
  });
}
