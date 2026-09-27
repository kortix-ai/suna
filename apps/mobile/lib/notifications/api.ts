import { API_URL, getAuthHeaders } from '@/api/config';
import { Platform } from 'react-native';
import { log } from '@/lib/logger';
import type { ServerPreferences } from '@/lib/notifications/push';

interface RegisterDeviceTokenRequest {
  device_token: string;
  device_type: 'ios' | 'android';
  provider: 'expo';
  /** Omitted keys keep their stored values on the server. */
  preferences?: ServerPreferences;
}

interface RegisterDeviceTokenResponse {
  success: boolean;
  message: string;
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    
    if (response.status !== 401 && response.status !== 403) {
      log.error('❌ Notifications API Error:', {
        endpoint,
        status: response.status,
        error: errorData,
      });
    }
    
    const errorMessage = errorData.detail?.message || errorData.detail || errorData.message || response.statusText;
    throw new Error(`HTTP ${response.status}: ${errorMessage}`);
  }

  return response.json();
}

export const notificationsApi = {
  /** Idempotent upsert: re-registering the same token only updates its preferences. */
  async registerDeviceToken(
    deviceToken: string,
    preferences?: ServerPreferences
  ): Promise<RegisterDeviceTokenResponse> {
    log.log('📲 Registering device token...');
    
    const deviceType = Platform.OS === 'ios' ? 'ios' : 'android';
    
    const request: RegisterDeviceTokenRequest = {
      device_token: deviceToken,
      device_type: deviceType,
      provider: 'expo',
      ...(preferences ? { preferences } : {}),
    };

    const response = await fetchApi<RegisterDeviceTokenResponse>(
      '/notifications/device-token',
      {
        method: 'POST',
        body: JSON.stringify(request),
      }
    );

    log.log('✅ Device token registered successfully');
    return response;
  },

  /** Idempotent. `signal` aborts the request (the sign-out deadline). */
  async unregisterDeviceToken(deviceToken: string, signal?: AbortSignal): Promise<void> {
    log.log('🗑️ Unregistering device token...');
    
    await fetchApi<{ success: boolean; deleted?: boolean }>(
      `/notifications/device-token/${encodeURIComponent(deviceToken)}`,
      {
        method: 'DELETE',
        signal,
      }
    );

    log.log('✅ Device token unregistered successfully');
  },
};
