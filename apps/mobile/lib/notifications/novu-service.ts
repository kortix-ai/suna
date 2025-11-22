import messaging from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { supabase } from '@/api/supabase';

class MobileNotificationService {
  private fcmToken: string | null = null;

  async requestPermission(): Promise<boolean> {
    try {
      const authStatus = await messaging().requestPermission();
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      if (enabled) {
        console.log('Push notification permission granted');
        return true;
      } else {
        console.log('Push notification permission denied');
        return false;
      }
    } catch (error) {
      console.error('Error requesting push notification permission:', error);
      return false;
    }
  }

  async registerDeviceToken(): Promise<string | null> {
    try {
      const hasPermission = await this.requestPermission();
      
      if (!hasPermission) {
        console.log('Push notifications permission not granted');
        return null;
      }

      const token = await messaging().getToken();
      this.fcmToken = token;

      console.log('FCM Token:', token);

      await this.sendTokenToBackend(token);

      return token;
    } catch (error) {
      console.error('Error getting FCM token:', error);
      return null;
    }
  }

  async sendTokenToBackend(token: string): Promise<void> {
    try {
      const { data, error } = await supabase.functions.invoke('notifications/device-token', {
        body: {
          device_token: token,
          device_type: Platform.OS,
          provider: 'fcm',
        },
      });

      if (error) {
        console.error('Error registering device token with backend:', error);
        throw error;
      }

      console.log('Device token registered with backend:', data);
    } catch (error) {
      console.error('Failed to send token to backend:', error);
      throw error;
    }
  }

  async unregisterDeviceToken(): Promise<void> {
    try {
      if (!this.fcmToken) {
        console.log('No FCM token to unregister');
        return;
      }

      const { error } = await supabase.functions.invoke(
        `notifications/device-token/${encodeURIComponent(this.fcmToken)}`,
        {
          method: 'DELETE',
        }
      );

      if (error) {
        console.error('Error unregistering device token:', error);
        throw error;
      }

      console.log('Device token unregistered successfully');
      this.fcmToken = null;
    } catch (error) {
      console.error('Failed to unregister token:', error);
      throw error;
    }
  }

  setupNotificationHandlers() {
    messaging().onMessage(async remoteMessage => {
      console.log('Foreground notification received:', remoteMessage);
      
      if (remoteMessage.notification) {
        this.displayLocalNotification(
          remoteMessage.notification.title || 'New Notification',
          remoteMessage.notification.body || ''
        );
      }
    });

    messaging().setBackgroundMessageHandler(async remoteMessage => {
      console.log('Background notification received:', remoteMessage);
    });

    messaging().onNotificationOpenedApp(remoteMessage => {
      console.log('Notification opened app:', remoteMessage);
      
      if (remoteMessage.data?.thread_id) {
        this.handleNotificationNavigation(remoteMessage.data as Record<string, string>);
      }
    });

    messaging()
      .getInitialNotification()
      .then(remoteMessage => {
        if (remoteMessage) {
          console.log('Notification opened app from quit state:', remoteMessage);
          
          if (remoteMessage.data?.thread_id) {
            this.handleNotificationNavigation(remoteMessage.data as Record<string, string>);
          }
        }
      });
  }

  private displayLocalNotification(title: string, body: string) {
    console.log('Display local notification:', { title, body });
  }

  private handleNotificationNavigation(data: Record<string, string>) {
    console.log('Handle notification navigation:', data);
  }

  async getNotificationSettings(): Promise<any> {
    try {
      const { data, error } = await supabase.functions.invoke('notifications/settings');

      if (error) {
        console.error('Error fetching notification settings:', error);
        throw error;
      }

      return data?.settings;
    } catch (error) {
      console.error('Failed to get notification settings:', error);
      throw error;
    }
  }

  async updateNotificationSettings(settings: Record<string, any>): Promise<void> {
    try {
      const { error } = await supabase.functions.invoke('notifications/settings', {
        method: 'PUT',
        body: settings,
      });

      if (error) {
        console.error('Error updating notification settings:', error);
        throw error;
      }

      console.log('Notification settings updated successfully');
    } catch (error) {
      console.error('Failed to update notification settings:', error);
      throw error;
    }
  }

  getFCMToken(): string | null {
    return this.fcmToken;
  }
}

export const mobileNotificationService = new MobileNotificationService();

