'use client';

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { User, Session } from '@supabase/supabase-js';
import { SupabaseClient } from '@supabase/supabase-js';
import { setBootstrapAuthToken, setCachedAuthToken } from '@/lib/auth-token';
import { IDENTITY_MARKER_KEY, shouldResetClientState } from '@/lib/auth/identity-marker';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { resetClientState } from '@/lib/utils/reset-client-state';
import { safeGetItem, safeSetItem } from '@/lib/storage/managed-storage';
// Auth tracking moved to AuthEventTracker component (handles OAuth redirects)

type AuthContextType = {
  supabase: SupabaseClient;
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const supabase = createClient();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  /**
   * The last user THIS document published. The localStorage marker cannot do
   * this job: it is one origin-wide value, so two tabs signed into two accounts
   * overwrite each other's while each keeps its own React Query cache. See
   * `lib/auth/identity-marker.ts` for what each marker is allowed to mean.
   */
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    /**
     * Make the client state safe to hand to `nextUserId`, then record that it
     * belongs to them. Resolves only once any wipe has finished, so callers can
     * publish the new user immediately after awaiting it.
     */
    const adoptUser = async (nextUserId: string) => {
      const mustReset = shouldResetClientState({
        inDocumentUserId: lastUserIdRef.current,
        persistedUserId: safeGetItem(IDENTITY_MARKER_KEY),
        nextUserId,
      });

      if (mustReset) {
        try {
          await resetClientState();
        } catch (error) {
          // Swallowed on purpose. This runs BEFORE the user is published and
          // before `isLoading` is cleared; an escaping rejection would leave
          // the whole app parked on the loading frame forever.
          console.error('[AuthProvider] Failed to clear state for the incoming user:', error);
        }
      }

      lastUserIdRef.current = nextUserId;
      safeSetItem(IDENTITY_MARKER_KEY, nextUserId);
    };

    const getInitialSession = async () => {
      try {
        const {
          data: { session: currentSession },
        } = await supabase.auth.getSession();

        if (currentSession) {
          // Validate the session against the auth server — catches stale
          // sessions after a DB reset where the JWT is valid but the user
          // no longer exists.
          const { error: userError } = await supabase.auth.getUser();
          if (userError) {
            console.warn('[AuthProvider] Stale session detected, signing out:', userError.message);
            await supabase.auth.signOut();
            setBootstrapAuthToken(null);
            setCachedAuthToken(null);
            setSession(null);
            setUser(null);
            return;
          }
        }

        // Before the publish, not after: the state on screen belongs to
        // whoever the markers name, and handing it to a different account —
        // even for the length of one render — is the bug this guard exists for.
        if (currentSession?.user?.id) {
          await adoptUser(currentSession.user.id);
        }

        setSession(currentSession);
        setUser(currentSession?.user ?? null);
        if (currentSession?.access_token) {
          setCachedAuthToken(currentSession.access_token);
          setBootstrapAuthToken(null);
        }
      } catch (error) {
        console.warn('[AuthProvider] Failed to bootstrap initial session:', error);
      } finally {
        setIsLoading(false);
      }
    };

    getInitialSession();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        const nextUserId = newSession?.user?.id;

        // INITIAL_SESSION is here, and not only in the switch below, for one
        // reason: a cross-user COLD LOAD arrives as INITIAL_SESSION, and it
        // arrives before `getInitialSession()` has finished its `getUser()`
        // round trip. Publishing first would hand the previous account's
        // mounted caches to the new user for the whole length of the reset,
        // which is long enough for every consumer that reads on mount to fetch
        // against them.
        if (nextUserId && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN')) {
          await adoptUser(nextUserId);
        }

        setSession(newSession);
        setUser(newSession?.user ?? null);

        // Functional update: the previous `if (isLoading)` read a stale
        // `isLoading` captured at mount (the effect only depends on `supabase`),
        // so the guard never short-circuited. This is behavior-equivalent but
        // doesn't rely on a stale closure value.
        setIsLoading((prev) => (prev ? false : prev));
        switch (event) {
          case 'SIGNED_IN': {
            if (newSession?.access_token) {
              setCachedAuthToken(newSession.access_token);
              setBootstrapAuthToken(null);
            }
            break;
          }
          case 'SIGNED_OUT':
            setBootstrapAuthToken(null);
            setCachedAuthToken(null);
            await resetClientState();
            // The identity marker is deliberately LEFT IN PLACE. Removing it
            // here deleted the exact value the next `SIGNED_IN` compares
            // against, so after an explicit logout the cross-user reset could
            // never fire — the one moment two accounts are most likely to share
            // a browser. It is a user id, not a credential, and it is already
            // rewritten on every sign-in.
            break;
          case 'TOKEN_REFRESHED':
            if (newSession?.access_token) {
              setCachedAuthToken(newSession.access_token);
              setBootstrapAuthToken(null);
            }
            break;
          case 'MFA_CHALLENGE_VERIFIED':
            if (newSession?.access_token) {
              setCachedAuthToken(newSession.access_token);
              setBootstrapAuthToken(null);
            }
            break;
          default:
        }
      },
    );

    return () => {
      authListener?.subscription.unsubscribe();
    };
  }, [supabase]);

  // Memoize the context value to prevent cascading re-renders of the entire
  // component tree on every auth state change (e.g. silent token refreshes).
  //
  // `signOut` is the shared `performSignOut` itself, not a provider-local
  // wrapper: it is a module constant, so it is stable across renders, and
  // routing it through here is what keeps every consumer of `useAuth()` on the
  // one sign-out path instead of hand-rolling a fifth cleanup.
  const value = useMemo<AuthContextType>(
    () => ({ supabase, session, user, isLoading, signOut: performSignOut }),
    [supabase, session, user, isLoading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
