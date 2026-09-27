import { supabase } from './supabase';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';
import { log } from '@/lib/logger';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8008/v1';

export function getServerUrl(): string {
  const url = resolveLocalUrl(BACKEND_URL);
  log.log('📡 Using backend URL:', url);
  return url;
}

export const API_URL = getServerUrl();

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
