import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import 'react-native-url-polyfill/auto';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';
import { log } from '@/lib/logger';

/**
 * Supabase Configuration
 *
 * Configure with environment variables:
 * - EXPO_PUBLIC_SUPABASE_URL
 * - EXPO_PUBLIC_SUPABASE_ANON_KEY
 */

// expo-secure-store persists individual items in the OS Keychain (iOS) /
// Keystore (Android) instead of plaintext AsyncStorage, but each item is
// capped at ~2048 bytes — well under a Supabase session (access + refresh
// token + user metadata). Chunk values across multiple secure items and
// reassemble on read so the full session still fits.
const SECURE_STORE_CHUNK_SIZE = 1800;
const SECURE_STORE_CHUNK_COUNT_SUFFIX = '.chunks';

class ChunkedSecureStorage {
  async getItem(key: string): Promise<string | null> {
    const countRaw = await SecureStore.getItemAsync(`${key}${SECURE_STORE_CHUNK_COUNT_SUFFIX}`);
    const count = countRaw ? parseInt(countRaw, 10) : NaN;
    if (!Number.isFinite(count) || count <= 0) {
      return null;
    }

    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      if (part === null) {
        // Missing/corrupted chunk — treat the whole value as unreadable
        // rather than returning a truncated session token.
        return null;
      }
      parts.push(part);
    }
    return parts.join('');
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.removeItem(key);

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += SECURE_STORE_CHUNK_SIZE) {
      chunks.push(value.slice(i, i + SECURE_STORE_CHUNK_SIZE));
    }
    await Promise.all(chunks.map((chunk, i) => SecureStore.setItemAsync(`${key}.${i}`, chunk)));
    await SecureStore.setItemAsync(`${key}${SECURE_STORE_CHUNK_COUNT_SUFFIX}`, String(chunks.length));
  }

  async removeItem(key: string): Promise<void> {
    const countRaw = await SecureStore.getItemAsync(`${key}${SECURE_STORE_CHUNK_COUNT_SUFFIX}`);
    const count = countRaw ? parseInt(countRaw, 10) : 0;
    const deletions: Promise<void>[] = [
      SecureStore.deleteItemAsync(`${key}${SECURE_STORE_CHUNK_COUNT_SUFFIX}`),
    ];
    if (Number.isFinite(count) && count > 0) {
      for (let i = 0; i < count; i++) {
        deletions.push(SecureStore.deleteItemAsync(`${key}.${i}`));
      }
    }
    await Promise.all(deletions);
  }
}

const secureStorage = new ChunkedSecureStorage();

const supabaseUrl = resolveLocalUrl(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '');
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

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
 * Supabase client instance with a SecureStore-backed (Keychain/Keystore)
 * storage adapter for session persistence, so auth tokens never sit in
 * plaintext on-device storage.
 */
export const supabase = (() => {
  try {
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase credentials not configured');
    }

    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: secureStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
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

