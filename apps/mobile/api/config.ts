import { supabase } from './supabase';
import { createRefreshingToken } from './refreshing-token';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';
import { log } from '@/lib/logger';
import { resolveEndpoints } from '@/lib/deployment/deployment';
import { activeDeployment } from '@/lib/deployment/store';

// A private deployment chosen on the auth screen replaces the build's API URL.
const BACKEND_URL = resolveEndpoints(activeDeployment, {
  EXPO_PUBLIC_BACKEND_URL: process.env.EXPO_PUBLIC_BACKEND_URL,
}).backendUrl;

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

/** The SDK's `getToken`: a 401 makes the next read refresh the Supabase session. */
export const kortixGetToken = createRefreshingToken({
  read: getAuthToken,
  refresh: async () => {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? null;
  },
});

export async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getAuthToken();
  
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
