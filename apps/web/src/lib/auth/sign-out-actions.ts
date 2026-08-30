'use server';

import { AUTH_BOUNCE_COOKIE } from '@/lib/onboarding/landing-destination';
import { getEnv } from '@/lib/env-config';
import { createClient } from '@/lib/supabase/server';
import { recordPlatformLogout } from '@kortix/sdk';
import { cookies } from 'next/headers';

/**
 * Drop the middleware's bounce attribution.
 *
 * `AUTH_BOUNCE_COOKIE` is `httpOnly` (see the `redirectPreservingSession` branch
 * in `middleware.ts`), so no client can clear it with `document.cookie` — a
 * server round trip is the only route, and this action is it.
 *
 * Two callers, one reason each:
 *
 *  1. Authentication resolved a destination, so the bounce is SPENT. Leaving it
 *     behind would let one sign-in's attribution demote the next one, and every
 *     successful path needs it: password, OTP and signup all hand a destination
 *     back to the client without ever touching `/auth/callback`, so the clear
 *     beside that route's `ACTIVE_INSTANCE_COOKIE` reaches none of them.
 *  2. A sign-out ends the identity the bounce names. Middleware writes the
 *     cookie with a 300s life and only a successful sign-in clears it, so a
 *     logout otherwise leaves it armed — and the next account to sign in on
 *     this browser inside that window gets its return URL demoted by a bounce
 *     that belonged to somebody who has already left.
 *
 * Deleting it is always SAFE: an absent cookie reads as UNATTRIBUTED, which
 * never demotes (`shouldDemoteReturnUrl`). Clearing it too eagerly costs
 * nothing; leaving it costs a wrong destination.
 */
export async function clearAuthBounceCookie(): Promise<void> {
  (await cookies()).delete(AUTH_BOUNCE_COOKIE);
}

/**
 * The SERVER half of a sign-out, run before the browser drops its session.
 *
 * `supabase.auth.signOut()` is a client-side act: it invalidates the refresh
 * token at Supabase and clears the browser's cookies. It cannot revoke the
 * ACCESS token that is already minted, and it emits no audit event. This does
 * both, through `POST /v1/auth/logout`:
 *
 *  - marks every `account_session_activity` row for the session revoked. Be
 *    exact about the reach: `accountSessionGate()` is mounted on the ACCOUNTS
 *    router only (`apps/api/src/accounts/index.ts`), so the `revokedAt` 401
 *    covers `/v1/accounts/*` for the rest of the current access-token window.
 *    It is not a whole-API kill switch. Without it that window is only closed
 *    when Supabase refuses the next refresh;
 *  - emits the `auth.logout` audit event with the actor and session id. This
 *    half IS universal — the audit record is written regardless of which routes
 *    the gate protects.
 *
 * It ran on exactly ONE of the six sign-out controls before this was unified
 * (`auth/phone-verification`), so five of six logouts emitted no audit event
 * and revoked nothing. It runs on all six now.
 *
 * FIRST in the sequence, deliberately: it authenticates with the access token
 * that `supabase.auth.signOut()` is about to throw away.
 *
 * Best effort by construction. A backend that is down or slow must never be
 * able to keep a user signed in, so every failure is swallowed and the
 * client-side sign-out — which is authoritative for this browser — proceeds.
 * The 3s ceiling is the bound on how long that can delay the logout.
 *
 * It deliberately does NOT delete `kortix_last_project`. The old `signOut()`
 * action did, and it was the only logout path that did. That cookie is
 * owner-bound (`serializeLastProject`), so the next account cannot follow it,
 * and the middleware reads its OWNER half to attribute a bounce once identity
 * resolution has already returned `user: null` — which is exactly what happens
 * after a logout and on the dominant session-expiry path. Deleting it here
 * un-attributes every post-logout bounce.
 */
export async function finalizeServerSignOut(): Promise<void> {
  try {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.access_token) {
      // `getEnv()`, not `getServerPublicEnv()` — the two resolve `BACKEND_URL`
      // from the same variables in the same order, but `public-env-server`
      // carries `import 'server-only'`. This module is reachable from the
      // browser sign-out path (a client module has to import a server action to
      // get a reference to it), and that guard throws the moment anything in
      // that graph is loaded outside a React Server Component.
      const backendUrl = getEnv().BACKEND_URL || 'http://localhost:8008/v1';
      await recordPlatformLogout({
        backendUrl,
        accessToken: session.access_token,
        signal: AbortSignal.timeout(3_000),
      });
    }
  } catch {
    /* swallow — the server-side revoke is best-effort; the client sign-out is
       what actually ends this browser's session. */
  }

  await clearAuthBounceCookie();
}
