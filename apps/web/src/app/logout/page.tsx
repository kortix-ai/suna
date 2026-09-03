'use client';

import { useEffect } from 'react';

import Loading from '@/components/ui/loading';
import { performSignOut } from '@/lib/auth/perform-sign-out';

/**
 * `/logout` — type the URL, and you are signed out.
 *
 * A URL people can type, bookmark, or send to someone who is stuck. It runs the
 * SAME `performSignOut()` every in-app control runs, so it inherits the whole
 * exit path rather than reimplementing it: the server-side session revoke, the
 * `{ error }` read with a local retry, the auth-cookie expiry that covers a
 * sign-out the network refused, `resetClientState()`, and the hard navigation
 * that discards Next's route, segment and bfcache. A second logout written here
 * would be a second thing to keep in step, and the first one to drift.
 *
 * Two properties this route needs that are NOT in this file, because they are
 * decided where the request is routed rather than where it is rendered:
 *
 * 1. It is PUBLIC (`middleware.ts` `PUBLIC_ROUTES`). Not because logging out is
 *    unauthenticated work, but because middleware turns any protected request
 *    into `/auth?redirect=<path>` — so a signed-out visitor typing `/logout`
 *    would be bounced to sign IN, and then, having signed in, be sent straight
 *    here and signed out again. Public means an already-signed-out visitor just
 *    lands on `/auth`, which is where they were going anyway.
 * 2. It can never be a post-sign-in destination (`LEGACY_AUTH_RETURN_PREFIXES`
 *    in `lib/auth/return-url.ts`). That closes the same loop from the other end:
 *    a `?redirect=/logout` arriving from anywhere — a stale link, a crafted one —
 *    is replaced with the landing door instead of undoing the sign-in that just
 *    happened.
 *
 * No confirmation dialog. A typed URL IS the intent; the in-app controls confirm
 * because they sit next to things you might click by accident, and a URL does
 * not. Re-entrancy is handled inside `performSignOut` (a second call navigates
 * rather than starting a second sequence), so React's double-invoked effect in
 * development needs no guard here.
 */
export default function LogoutPage() {
  useEffect(() => {
    void performSignOut();
  }, []);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3">
      <Loading className="size-5 shrink-0" />
      <p className="text-muted-foreground text-sm" aria-live="polite">
        Signing you out…
      </p>
    </main>
  );
}
