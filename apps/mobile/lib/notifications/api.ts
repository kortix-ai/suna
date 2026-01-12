import { API_URL, getAuthHeaders } from '@/api/config';
import { Platform } from 'react-native';
import { log } from '@/lib/logger';

interface RegisterDeviceTokenRequest {
  device_token: string;
  device_type?: string;
  provider?: string;
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
  async registerDeviceToken(
    deviceToken: string
  ): Promise<RegisterDeviceTokenResponse> {
    log.log('📲 Registering device token...');
    
    const deviceType = Platform.OS === 'ios' ? 'ios' : 'android';
    
    const request: RegisterDeviceTokenRequest = {
      device_token: deviceToken,
      device_type: deviceType,
      provider: 'expo',
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

  async unregisterDeviceToken(deviceToken: string): Promise<void> {
    log.log('🗑️ Unregistering device token...');
    
    await fetchApi<void>(
      `/notifications/device-token/${encodeURIComponent(deviceToken)}`,
      {
        method: 'DELETE',
      }
    );

    log.log('✅ Device token unregistered successfully');
  },
};
