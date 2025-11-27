import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { notificationsApi } from '@/lib/notifications/api';
import { useAuthContext } from '@/contexts';

// Safely import expo-device with fallback
let Device: typeof import('expo-device') | null = null;
try {
  Device = require('expo-device');
} catch (error) {
  console.warn('expo-device module not available:', error);
}

// Safely import expo-notifications with fallback
let Notifications: typeof import('expo-notifications') | null = null;
try {
  Notifications = require('expo-notifications');
} catch (error) {
  console.warn('expo-notifications module not available:', error);
}

export interface PushNotificationState {
  expoPushToken?: string;
  notification?: Notifications.Notification | undefined;
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
      console.log('Push notifications not available - native module not found');
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
        console.warn('Failed to set notification channel:', error);
      }
    }

    // Check if Device module is available and if running on a physical device
    const isPhysicalDevice = Device && typeof Device.isDevice !== 'undefined' && Device.isDevice;
    
    if (isPhysicalDevice && Notifications.getPermissionsAsync) {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted' && Notifications.requestPermissionsAsync) {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== 'granted') {
          console.log('Failed to get push token for push notification!');
          return undefined;
        }

        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        
        if (!projectId) {
          console.log('Project ID not found');
          return undefined;
        }

        if (Notifications.getExpoPushTokenAsync) {
          try {
            token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
            console.log('Expo Push Token:', token);
          } catch (e) {
            console.log('Error getting push token:', e);
          }
        }
      } catch (error) {
        console.warn('Error registering for push notifications:', error);
      }
    } else {
      console.log('Must use physical device for Push Notifications');
    }

    return token;
  }

  useEffect(() => {
    if (!Notifications) {
      return;
    }

    registerForPushNotificationsAsync().then(token => token && setExpoPushToken(token));

    if (Notifications.addNotificationReceivedListener) {
      notificationListener.current = Notifications.addNotificationReceivedListener((notification: any) => {
        setNotification(notification);
      });
    }

    if (Notifications.addNotificationResponseReceivedListener) {
      responseListener.current = Notifications.addNotificationResponseReceivedListener((response: any) => {
        console.log('Notification response:', response);
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
        console.error('Failed to register device token:', error);
      });
    }
  }, [expoPushToken, isAuthenticated]);

  return {
    expoPushToken,
    notification,
  };
};
