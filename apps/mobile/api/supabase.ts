import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import 'react-native-url-polyfill/auto';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';
import { log } from '@/lib/logger';
import { createDeadlineFetch } from '@/lib/utils/with-deadline';
import { createRefreshGuardFetch } from '@/lib/auth/refresh-fetch';
import { resolveEndpoints } from '@/lib/deployment/deployment';
import { activeDeployment } from '@/lib/deployment/store';

/**
 * Supabase Configuration
 *
 * The build's EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY, or the
 * private deployment chosen on the auth screen (lib/deployment): its web
 * runtime config names its own Supabase, so sign-in moves with the API.
 */

const endpoints = resolveEndpoints(activeDeployment, {
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});
const supabaseUrl = resolveLocalUrl(endpoints.supabaseUrl);
const supabaseAnonKey = endpoints.supabaseAnonKey;

// Validate environment variables
if (!supabaseUrl || supabaseUrl === 'YOUR_SUPABASE_URL' || (!supabaseUrl.startsWith('https://') && !supabaseUrl.startsWith('http://'))) {
  log.error('❌ EXPO_PUBLIC_SUPABASE_URL is not properly configured');
  log.log('Please set EXPO_PUBLIC_SUPABASE_URL in your environment variables');
}

if (!supabaseAnonKey || supabaseAnonKey === 'YOUR_SUPABASE_ANON_KEY' || supabaseAnonKey.length < 10) {
  log.error('❌ EXPO_PUBLIC_SUPABASE_ANON_KEY is not properly configured');
  log.log('Please set EXPO_PUBLIC_SUPABASE_ANON_KEY in your environment variables');
}

/**
 * AsyncStorage key of the persisted auth session. Same value supabase-js
 * derives by default (`sb-<first host label>-auth-token`); passed explicitly so
 * useAuth can read the stored session when the restore stalls.
 */
export const SUPABASE_AUTH_STORAGE_KEY = (() => {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  } catch {
    return undefined;
  }
})();

/**
 * The client's fetch:
 * - Auth calls abort after 15 s. React Native's Android HTTP client has no
 *   timeout, so a stalled token refresh would otherwise hang sign-in and
 *   session restore forever. Storage uploads are not capped: they can run
 *   longer.
 * - A token refresh answer that is not ok and not a definitive GoTrue
 *   rejection becomes a network error (`lib/auth/refresh-fetch.ts`). auth-js
 *   then keeps the stored session and retries, instead of signing out.
 */
const AUTH_REQUEST_TIMEOUT_MS = 15_000;
const authFetch = createRefreshGuardFetch(
  createDeadlineFetch((input, init) => fetch(input, init), {
    timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
    shouldTimeout: (url) => url.includes('/auth/v1/'),
  })
);

/**
 * Supabase client instance with AsyncStorage for session persistence
 */
export const supabase = (() => {
  try {
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase credentials not configured');
    }

    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: AsyncStorage,
        ...(SUPABASE_AUTH_STORAGE_KEY ? { storageKey: SUPABASE_AUTH_STORAGE_KEY } : {}),
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
      global: {
        // The wrapper has fetch's call signature; `typeof fetch` also carries
        // static members no caller uses.
        fetch: authFetch as typeof fetch,
      },
    });
  } catch (error) {
    log.error('Failed to initialize Supabase client:', error);
    // Return a mock client that throws errors for all operations
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: new Error('Supabase not configured') }),
        getUser: () => Promise.resolve({ data: { user: null }, error: new Error('Supabase not configured') }),
        signInWithPassword: () => Promise.resolve({ error: new Error('Supabase not configured') }),
        signUp: () => Promise.resolve({ error: new Error('Supabase not configured') }),
        signOut: () => Promise.resolve({ error: new Error('Supabase not configured') }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        startAutoRefresh: () => {},
        stopAutoRefresh: () => {},
      },
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: { code: 'MOCK_ERROR', message: 'Supabase not configured' } })
        })
      })
    } as any;
  }
})();

// Auto-refresh token when app becomes active
if (supabaseUrl && supabaseAnonKey) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}

