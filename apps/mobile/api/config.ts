import { Platform } from 'react-native';
import { supabase } from './supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8000/api';

const FRONTEND_URL = process.env.EXPO_PUBLIC_FRONTEND_URL || '';

export function getServerUrl(): string {
  let url = BACKEND_URL;

  if (Platform.OS === 'web') {
    return url;
  }

  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    const devHost = process.env.EXPO_PUBLIC_DEV_HOST || (
      Platform.OS === 'ios' ? 'localhost' : '10.0.2.2'
    );
    url = url.replace('localhost', devHost).replace('127.0.0.1', devHost);
    console.log('📡 Using backend URL:', url);
  }

  return url;
}

export const API_URL = getServerUrl();
export const FRONTEND_SHARE_URL = FRONTEND_URL;

export async function getAuthToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

export async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getAuthToken();
  
  const isGuestMode = await AsyncStorage.getItem('@kortix_guest_mode');
  const guestSessionId = await AsyncStorage.getItem('@kortix_guest_session_id');
  
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(isGuestMode === 'true' && guestSessionId ? { 'X-Guest-Session': guestSessionId } : {}),
  };
}
