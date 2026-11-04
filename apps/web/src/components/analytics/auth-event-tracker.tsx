'use client';

import { AuthMethod, trackLogin, trackSignUp } from '@/lib/analytics/gtm';
import { track } from '@/lib/track';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Tracks auth events (sign_up, login) from URL parameters
 * after OAuth/magic link redirects
 */
export function AuthEventTracker() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // The live URL, not the hook's snapshot: once a run below strips the
    // params, a second run of this effect (a re-render, React's dev double
    // mount) finds none and reports nothing twice.
    const live = new URLSearchParams(window.location.search);
    const authEvent = live.get('auth_event');
    const authMethod = live.get('auth_method');

    if (authEvent && authMethod) {
      // Map provider to AuthMethod format
      const method: AuthMethod =
        authMethod === 'google'
          ? 'Google'
          : authMethod === 'apple'
            ? 'Apple'
            : authMethod === 'github'
              ? 'GitHub'
              : 'Email';

      if (authEvent === 'signup') {
        trackSignUp(method);
      } else if (authEvent === 'login') {
        trackLogin(method);
      }
      if (authEvent === 'signup' || authEvent === 'login') {
        track('auth_completed', { kind: authEvent, method: method.toLowerCase() });
      }

      // Clean up URL params after tracking
      const params = live;
      params.delete('auth_event');
      params.delete('auth_method');

      const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;

      // Replace URL without triggering navigation
      window.history.replaceState({}, '', newUrl);
    }
  }, [searchParams, pathname, router]);

  return null;
}
