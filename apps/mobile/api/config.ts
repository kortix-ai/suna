import { Platform } from 'react-native';
import { supabase } from './supabase';
import { ENV_MODE, EnvMode } from '@/lib/utils/env-config';
import { log } from '@/lib/logger';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8000/v1';

const FRONTEND_URL = process.env.EXPO_PUBLIC_FRONTEND_URL || '';

export function getServerUrl(): string {
  let url = BACKEND_URL;

  if (Platform.OS === 'web') {
    log.log('📡 Using backend URL (web):', url);
    return url;
  }

  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    const devHost = process.env.EXPO_PUBLIC_DEV_HOST || (
      Platform.OS === 'ios' ? 'localhost' : '10.0.2.2'
    );
    url = url.replace('localhost', devHost).replace('127.0.0.1', devHost);
    log.log('📡 Using backend URL (localhost):', url);
  } else {
    log.log('📡 Using backend URL:', url);
  }

  return url;
}

/**
 * Get the frontend URL based on environment
 * Used for auth redirects, sharing links, etc.
 *
 * Priority:
 * 1. EXPO_PUBLIC_FRONTEND_URL if set (explicit override)
 * 2. Infer from backend URL (if backend is production, frontend should be too)
 * 3. Environment-based defaults (staging by default for Expo apps)
 */
export function getFrontendUrl(): string {
  // If explicitly set, use that
  if (FRONTEND_URL) {
    return FRONTEND_URL.replace(/\/$/, ''); // Remove trailing slash
  }

  // Infer from backend URL - if backend is production, frontend should be too
  if (BACKEND_URL.includes('api.kortix.com') || BACKEND_URL.includes('api.suna.so')) {
    return 'https://kortix.com';
  }
  if (BACKEND_URL.includes('staging.api') || BACKEND_URL.includes('staging-api')) {
    return 'https://staging.suna.so';
  }

  // Fall back to environment-based defaults
  switch (ENV_MODE) {
    case EnvMode.PRODUCTION:
      return 'https://kortix.com';
    case EnvMode.STAGING:
      return 'https://staging.suna.so';
    case EnvMode.LOCAL:
    default:
      return 'http://localhost:3000';
  }
}

export const API_URL = getServerUrl();
export const FRONTEND_SHARE_URL = getFrontendUrl();

export async function getAuthToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

export async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getAuthToken();
  
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
