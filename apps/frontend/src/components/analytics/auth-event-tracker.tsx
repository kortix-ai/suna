'use client';

import { useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { trackSignUp, trackLogin, AuthMethod } from '@/lib/analytics/gtm';

/**
 * Tracks auth events (sign_up, login) from URL parameters
 * after OAuth/magic link redirects
 */
export function AuthEventTracker() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const authEvent = searchParams?.get('auth_event');
    const authMethod = searchParams?.get('auth_method');

    if (authEvent && authMethod) {
      // Map provider to AuthMethod format
      const method: AuthMethod = 
        authMethod === 'google' ? 'Google' :
        authMethod === 'apple' ? 'Apple' :
        authMethod === 'github' ? 'GitHub' : 'Email';

      if (authEvent === 'signup') {
        trackSignUp(method);
      } else if (authEvent === 'login') {
        trackLogin(method);
      }

      // Clean up URL params after tracking
      const params = new URLSearchParams(searchParams?.toString() || '');
      params.delete('auth_event');
      params.delete('auth_method');
      
      const newUrl = params.toString() 
        ? `${pathname}?${params.toString()}`
        : pathname;
      
      // Replace URL without triggering navigation
      window.history.replaceState({}, '', newUrl);
    }
  }, [searchParams, pathname, router]);

  return null;
}

