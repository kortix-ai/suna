'use client';

/**
 * Desktop-bundle OAuth landing.
 *
 * Replaces the real `(auth)/auth/callback/route.ts`, which is a server route
 * handler and cannot exist in a static export (desktop/build.mjs hides it).
 *
 * THE ROUND TRIP
 *   1. The bundled app starts OAuth. Its Supabase client uses the IMPLICIT flow
 *      (src/lib/supabase/client.ts) — the app runs on a loopback origin and the
 *      consent screen happens in the user's real browser, so a PKCE verifier
 *      written at step 1 is not readable here. Measured, not assumed:
 *      "PKCE code verifier not found in storage".
 *   2. `redirectTo` is the REMOTE allowlisted origin's /auth/callback?desktop=true.
 *      A loopback URL cannot be in the Supabase redirect allowlist.
 *   3. That route renders the bounce page, which navigates to
 *      `kortix://auth/callback#access_token=…&refresh_token=…`.
 *   4. The shell rewrites the deep link onto this page, fragment included
 *      (main.js translateDeepLink).
 *   5. We call setSession() with the tokens. The session now lives on the
 *      origin the app actually runs on.
 *
 * The fragment is read from `window.location.hash`, never from useSearchParams:
 * a URL fragment is not sent to any server and is not part of the query string.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { createClient } from '@/lib/supabase/client';

export default function DesktopAuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // A session hand-off is single-use; StrictMode double-invokes effects.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const query = new URLSearchParams(window.location.search);
      const read = (name: string) => hash.get(name) ?? query.get(name);

      // Supabase reports failures as params, not as an HTTP status.
      const failure = read('error_description') || read('error');
      if (failure) {
        setError(failure);
        return;
      }

      const accessToken = read('access_token');
      const refreshToken = read('refresh_token');
      if (!accessToken || !refreshToken) {
        setError('The sign-in callback carried no session.');
        return;
      }

      const supabase = createClient();
      const { error: setErr } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (setErr) {
        setError(setErr.message);
        return;
      }

      // Drop the tokens out of the address bar before moving on.
      window.history.replaceState(null, '', window.location.pathname);
      router.replace(read('returnUrl') || PROJECT_LANDING_PATH);
    };

    void run();
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        {error ? (
          <>
            <p className="text-sm text-foreground">Could not complete sign-in.</p>
            <p className="mt-2 text-xs text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={() => router.replace('/auth')}
              className="mt-6 text-xs underline underline-offset-4 text-muted-foreground hover:text-foreground"
            >
              Try again
            </button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Signing you in\u2026</p>
        )}
      </div>
    </div>
  );
}
