import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { Notification } from 'expo-notifications';
import { notificationsApi } from '@/lib/notifications/api';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';

// Safely import expo-device with fallback
let Device: typeof import('expo-device') | null = null;
try {
  Device = require('expo-device');
} catch (error) {
  log.warn('expo-device module not available:', error);
}

// Safely import expo-notifications with fallback
let Notifications: typeof import('expo-notifications') | null = null;
try {
  Notifications = require('expo-notifications');
} catch (error) {
  log.warn('expo-notifications module not available:', error);
}

export interface PushNotificationState {
  expoPushToken?: string;
  notification?: Notification | undefined;
}

export const usePushNotifications = (): PushNotificationState => {
  const [expoPushToken, setExpoPushToken] = useState<string>();
  const [notification, setNotification] = useState<any>(undefined);
  const { isAuthenticated } = useAuthContext();

  const notificationListener = useRef<any>(undefined);
  const responseListener = useRef<any>(undefined);

  async function registerForPushNotificationsAsync() {
    // Early return if notifications module is not available
    if (!Notifications) {
      log.log('[PUSH] Push notifications not available - native module not found');
      return undefined;
    }

    let token;

    if (Platform.OS === 'android' && Notifications.setNotificationChannelAsync) {
      try {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'default',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF231F7C',
        });
      } catch (error) {
        log.warn('[PUSH] Failed to set notification channel:', error);
      }
    }

    // Check if Device module is available and if running on a physical device
    const isPhysicalDevice = Device && typeof Device.isDevice !== 'undefined' && Device.isDevice;
    
    log.log('[PUSH] Device check:', {
      hasDeviceModule: !!Device,
      isPhysicalDevice,
      platform: Platform.OS,
    });
    
    if (isPhysicalDevice && Notifications.getPermissionsAsync) {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        log.log('[PUSH] Initial permission status:', existingStatus);

        if (existingStatus !== 'granted' && Notifications.requestPermissionsAsync) {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
          log.log('[PUSH] Permission request result:', status);
        }

        if (finalStatus !== 'granted') {
          log.log('[PUSH] ❌ Failed to get push token - permissions not granted. Status:', finalStatus);
          return undefined;
        }

        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        
        log.log('[PUSH] Project ID check:', {
          projectId: projectId || 'NOT FOUND',
          fromExpoConfig: !!Constants?.expoConfig?.extra?.eas?.projectId,
          fromEasConfig: !!Constants?.easConfig?.projectId,
        });
        
        if (!projectId) {
          log.log('[PUSH] ❌ Project ID not found - cannot get push token');
          return undefined;
        }

        if (Notifications.getExpoPushTokenAsync) {
          try {
            token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
            log.log('[PUSH] ✅ Expo Push Token retrieved:', token);
          } catch (e) {
            log.log('[PUSH] ❌ Error getting push token:', e);
          }
        } else {
          log.log('[PUSH] ❌ getExpoPushTokenAsync not available');
        }
      } catch (error) {
        log.warn('[PUSH] ❌ Error registering for push notifications:', error);
      }
    } else {
      log.log('[PUSH] ⚠️ Must use physical device for Push Notifications', {
        isPhysicalDevice,
        hasPermissionsMethod: !!Notifications?.getPermissionsAsync,
      });
    }

    if (!token) {
      log.log('[PUSH] ⚠️ expoPushToken will be undefined');
    }

    return token;
  }

  useEffect(() => {
    if (!Notifications) {
      log.log('[PUSH] Notifications module not available, skipping registration');
      return;
    }

    log.log('[PUSH] Starting push notification registration...');
    registerForPushNotificationsAsync().then(token => {
      if (token) {
        log.log('[PUSH] ✅ Setting expoPushToken:', token);
        setExpoPushToken(token);
      } else {
        log.log('[PUSH] ⚠️ No token received, expoPushToken will remain undefined');
      }
    });

    if (Notifications.addNotificationReceivedListener) {
      notificationListener.current = Notifications.addNotificationReceivedListener((notification: any) => {
        setNotification(notification);
      });
    }

    if (Notifications.addNotificationResponseReceivedListener) {
      responseListener.current = Notifications.addNotificationResponseReceivedListener((response: any) => {
        log.log('Notification response:', response);
      });
    }

    return () => {
      if (notificationListener.current && notificationListener.current.remove) {
        notificationListener.current.remove();
      }
      if (responseListener.current && responseListener.current.remove) {
        responseListener.current.remove();
      }
    };
  }, []);

  useEffect(() => {
    if (expoPushToken && isAuthenticated) {
      notificationsApi.registerDeviceToken(expoPushToken).catch(error => {
        log.error('Failed to register device token:', error);
      });
    }
  }, [expoPushToken, isAuthenticated]);

  return {
    expoPushToken,
    notification,
  };
};
