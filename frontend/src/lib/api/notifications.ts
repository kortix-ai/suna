import { API_BASE_URL } from './config';

export interface NotificationSettings {
  user_id: string;
  email_enabled: boolean;
  push_enabled: boolean;
  in_app_enabled: boolean;
  sms_enabled: boolean;
  task_notifications: boolean;
  billing_notifications: boolean;
  promotional_notifications: boolean;
  system_notifications: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  timezone: string;
}

export interface DeviceTokenRequest {
  device_token: string;
  device_type?: string;
  provider?: string;
}

export interface NotificationLog {
  id: string;
  user_id: string;
  event_type: string;
  channel: string;
  status: string;
  novu_transaction_id?: string;
  error_message?: string;
  payload?: Record<string, any>;
  created_at: string;
}

export class NotificationAPI {
  private async fetchWithAuth(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(error.detail || `Request failed: ${response.status}`);
    }

    return response.json();
  }

  async getSettings(): Promise<NotificationSettings> {
    const data = await this.fetchWithAuth('/api/notifications/settings');
    return data.settings;
  }

  async updateSettings(settings: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const data = await this.fetchWithAuth('/api/notifications/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
    return data.settings;
  }

  async registerDeviceToken(tokenRequest: DeviceTokenRequest): Promise<void> {
    await this.fetchWithAuth('/api/notifications/device-token', {
      method: 'POST',
      body: JSON.stringify(tokenRequest),
    });
  }

  async unregisterDeviceToken(deviceToken: string): Promise<void> {
    await this.fetchWithAuth(`/api/notifications/device-token/${encodeURIComponent(deviceToken)}`, {
      method: 'DELETE',
    });
  }

  async sendTestNotification(
    title: string = 'Test Notification',
    message: string = 'This is a test notification',
    channels?: string[]
  ): Promise<void> {
    await this.fetchWithAuth('/api/notifications/test', {
      method: 'POST',
      body: JSON.stringify({
        title,
        message,
        channels,
      }),
    });
  }

  async getLogs(limit: number = 50, offset: number = 0, eventType?: string): Promise<NotificationLog[]> {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
    });
    
    if (eventType) {
      params.append('event_type', eventType);
    }

    const data = await this.fetchWithAuth(`/api/notifications/logs?${params}`);
    return data.logs;
  }
}

export const notificationAPI = new NotificationAPI();

