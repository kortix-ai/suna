import { isStagingMode } from '@/lib/config';
import { backendApi } from '../api-client';


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
  private checkEnabled() {
    if (!isStagingMode()) {
      throw new Error('Notifications are only available in staging mode');
    }
  }

  async getSettings(): Promise<NotificationSettings> {
    this.checkEnabled();
    const response = await backendApi.get<{ settings: NotificationSettings }>('/notifications/settings');
    if (!response.success || !response.data) {
      throw new Error('Failed to fetch notification settings');
    }
    return response.data.settings;
  }

  async updateSettings(settings: Partial<NotificationSettings>): Promise<NotificationSettings> {
    this.checkEnabled();
    const response = await backendApi.put<{ settings: NotificationSettings }>(
      '/notifications/settings',
      settings
    );
    if (!response.success || !response.data) {
      throw new Error('Failed to update notification settings');
    }
    return response.data.settings;
  }

  async registerDeviceToken(tokenRequest: DeviceTokenRequest): Promise<void> {
    this.checkEnabled();
    const response = await backendApi.post('/notifications/device-token', tokenRequest);
    if (!response.success) {
      throw new Error('Failed to register device token');
    }
  }

  async unregisterDeviceToken(deviceToken: string): Promise<void> {
    this.checkEnabled();
    const response = await backendApi.delete(
      `/notifications/device-token/${encodeURIComponent(deviceToken)}`
    );
    if (!response.success) {
      throw new Error('Failed to unregister device token');
    }
  }

  async sendTestNotification(
    title: string = 'Test Notification',
    message: string = 'This is a test notification',
    channels?: string[]
  ): Promise<void> {
    this.checkEnabled();
    const response = await backendApi.post('/notifications/test', {
      title,
      message,
      channels,
    });
    if (!response.success) {
      throw new Error('Failed to send test notification');
    }
  }

  async getLogs(limit: number = 50, offset: number = 0, eventType?: string): Promise<NotificationLog[]> {
    this.checkEnabled();
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
    });
    
    if (eventType) {
      params.append('event_type', eventType);
    }

    const response = await backendApi.get<{ logs: NotificationLog[] }>(
      `/notifications/logs?${params}`
    );
    if (!response.success || !response.data) {
      throw new Error('Failed to fetch notification logs');
    }
    return response.data.logs;
  }
}

export const notificationAPI = new NotificationAPI();

