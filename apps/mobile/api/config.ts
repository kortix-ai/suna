/**
 * API Configuration
 * Simple config for API requests
 */

import { Platform } from 'react-native';
import { supabase } from './supabase';

// Backend URL from environment
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8000/api';

/**
 * Get the correct server URL based on platform
 */
function getServerUrl(): string {
  let url = BACKEND_URL;

  if (Platform.OS === 'web') {
    return url;
  }

  // For React Native, replace localhost with the correct IP
  // if (url.includes('localhost') || url.includes('127.0.0.1')) {
  //   const devHost = process.env.EXPO_PUBLIC_DEV_HOST || (
  //     Platform.OS === 'ios' ? 'localhost' : '10.0.2.2'
  //   );
  //   url = url.replace('localhost', devHost).replace('127.0.0.1', devHost);
  // }

  return url;
}

export const API_URL = getServerUrl();

/**
 * Get authentication token from Supabase
 */
export async function getAuthToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

/**
 * Get auth headers for API requests
 */
export async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getAuthToken();
  
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
