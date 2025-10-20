import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import 'react-native-url-polyfill/auto';

// Use your existing environment variables
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Validate that required env vars are set
if (!supabaseUrl || supabaseUrl === 'YOUR_SUPABASE_URL' || !supabaseUrl.startsWith('https://')) {
  console.error('❌ EXPO_PUBLIC_SUPABASE_URL is not properly configured');
  console.log('Please set EXPO_PUBLIC_SUPABASE_URL in your environment variables');
}

if (!supabaseAnonKey || supabaseAnonKey === 'YOUR_SUPABASE_ANON_KEY' || supabaseAnonKey.length < 10) {
  console.error('❌ EXPO_PUBLIC_SUPABASE_ANON_KEY is not properly configured');
  console.log('Please set EXPO_PUBLIC_SUPABASE_ANON_KEY in your environment variables');
}

// Create Supabase client with proper error handling
export const supabase = (() => {
  try {
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase credentials not configured');
    }

    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  } catch (error) {
    console.error('Failed to initialize Supabase client:', error);
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

// Auto-refresh token when app becomes active (only if real client)
if (supabaseUrl && supabaseAnonKey) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}

export const createSupabaseClient = () => {
  return supabase;
}; 