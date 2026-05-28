'use client';

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  ReactNode,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { User, Session } from '@supabase/supabase-js';
import { SupabaseClient } from '@supabase/supabase-js';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { setBootstrapAuthToken, setCachedAuthToken } from '@/lib/auth-token';
import { clearSessionIDBCache } from '@/lib/idb-sync-cache';
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

  useEffect(() => {
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

        setSession(currentSession);
        setUser(currentSession?.user ?? null);
        if (currentSession?.access_token) {
          setCachedAuthToken(currentSession.access_token);
          setBootstrapAuthToken(null);
        }

        // Track user ID for cross-account localStorage cleanup
        if (currentSession?.user?.id) {
          const prevUserId = localStorage.getItem('kortix-last-user-id');
          if (prevUserId && prevUserId !== currentSession.user.id) {
            console.log('[Auth] Initial session: user changed, clearing stale local storage');
            clearUserLocalStorage();
            await clearSessionIDBCache();
          }
          localStorage.setItem('kortix-last-user-id', currentSession.user.id);
        }
      } catch (error) {
      } finally {
        setIsLoading(false);
      }
    };

    getInitialSession();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
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
            // Clear stale sandbox/server state if a different user signs in
            // (e.g. signup in same browser without explicit logout first)
            const prevUserId = localStorage.getItem('kortix-last-user-id');
            const newUserId = newSession?.user?.id;
            if (newUserId && prevUserId && prevUserId !== newUserId) {
              console.log('[Auth] User changed, clearing stale local storage');
              clearUserLocalStorage();
              await clearSessionIDBCache();
            }
            if (newUserId) {
              localStorage.setItem('kortix-last-user-id', newUserId);
            }
            break;
          }
          case 'SIGNED_OUT':
            setBootstrapAuthToken(null);
            setCachedAuthToken(null);
            clearUserLocalStorage();
            await clearSessionIDBCache();
            localStorage.removeItem('kortix-last-user-id');
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

  const signOut = useCallback(async () => {
    try {
      await supabase.auth.signOut();
      clearUserLocalStorage();
      await clearSessionIDBCache();
    } catch (error) {
      console.error('Error signing out:', error);
    }
  }, [supabase]);

  // Memoize the context value to prevent cascading re-renders of the entire
  // component tree on every auth state change (e.g. silent token refreshes).
  const value = useMemo<AuthContextType>(
    () => ({ supabase, session, user, isLoading, signOut }),
    [supabase, session, user, isLoading, signOut],
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
