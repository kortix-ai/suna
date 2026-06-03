import { Platform } from 'react-native';
import { supabase } from './supabase';
import { log } from '@/lib/logger';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8000/v1';

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
