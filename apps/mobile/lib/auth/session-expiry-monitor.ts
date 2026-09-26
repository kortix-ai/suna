/**
 * The app's one expired-login monitor (COR-144), wired to Supabase. The
 * decisions live in `session-expiry.ts`; this file only supplies the refresh
 * call and the `SIGNED_OUT` event.
 *
 * Callers:
 * - `reportUnauthorized()`: `configureKortix` `onError` (API 401) and the
 *   sandbox stream (401/403, `event-stream.ts`).
 * - `sessionExpiry.disarm()`: every deliberate sign-out, before it calls
 *   `supabase.auth.signOut` (`useAuth.signOut`, the OAuth admission reject,
 *   account deletion).
 * - `SessionEndedDialog` arms the monitor while a user is signed in and
 *   installs the auth listener.
 */

import type { AuthChangeEvent } from '@supabase/supabase-js';
import { supabase } from '@/api/supabase';
import { log } from '@/lib/logger';
import { createSessionExpiryMonitor, useSessionExpiryStore } from './session-expiry';

export const sessionExpiry = createSessionExpiryMonitor({
  refresh: async () => {
    const { data, error } = await supabase.auth.refreshSession();
    return { error: error ?? null, hasSession: Boolean(data?.session) };
  },
  onChange: (phase) => {
    if (phase === 'expired') log.warn('🔒 Login ended; asking the user to sign in again');
    useSessionExpiryStore.setState({ phase });
  },
});

/** A request answered 401. Checks the login once; never throws. */
export function reportUnauthorized(): void {
  void sessionExpiry.reportUnauthorized().catch(() => {});
}

/** Listen for the `SIGNED_OUT` auth-js emits when a refresh fails for good. */
export function installSessionExpiryListener(): () => void {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
    if (event === 'SIGNED_OUT') sessionExpiry.signedOut();
  });
  return () => subscription.unsubscribe();
}
