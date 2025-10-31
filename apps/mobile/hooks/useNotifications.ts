import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useAuthContext } from '@/contexts';

// Dynamically import expo modules (may not be installed)
let Notifications: any = null;
let Device: any = null;

try {
  Notifications = require('expo-notifications');
  Device = require('expo-device');
  
  // Configure notification handler
  if (Notifications && Notifications.setNotificationHandler) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }
} catch (err) {
  console.warn('expo-notifications or expo-device not available:', err);
}

interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'agent_complete';
  category?: string;
  thread_id?: string;
  is_read: boolean;
  created_at: string;
}

interface NotificationListResponse {
  notifications: Notification[];
  total: number;
  unread_count: number;
}

async function getNotifications(params?: {
  page?: number;
  page_size?: number;
  is_read?: boolean;
}): Promise<NotificationListResponse> {
  const headers = await getAuthHeaders();
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.append('page', params.page.toString());
  if (params?.page_size) queryParams.append('page_size', params.page_size.toString());
  if (params?.is_read !== undefined) queryParams.append('is_read', params.is_read.toString());

  const response = await fetch(`${API_URL}/notifications?${queryParams}`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch notifications');
  }

  const data = await response.json();
  return {
    notifications: data.notifications || [],
    total: data.total || 0,
    unread_count: data.unread_count || 0,
  };
}

async function registerPushToken(token: string): Promise<{ success: boolean }> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/notifications/register-push-token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ push_token: token }),
  });

  if (!response.ok) {
    throw new Error('Failed to register push token');
  }

  return response.json();
}

async function markAsRead(notificationIds: string[]): Promise<{ success: boolean }> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}/notifications/read-all`, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ notification_ids: notificationIds }),
  });

  if (!response.ok) {
    throw new Error('Failed to mark notifications as read');
  }

  return response.json();
}

export function useNotifications(
  params?: { page?: number; page_size?: number; is_read?: boolean },
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: ['notifications', params],
    queryFn: () => getNotifications(params),
    enabled: options?.enabled !== false && params !== undefined,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}

export function useRegisterPushNotifications() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: registerPushToken,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkNotificationAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: markAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/**
 * Hook to register for push notifications and handle incoming notifications
 */
export function usePushNotifications() {
  const notificationListener = useRef<any>(null);
  const responseListener = useRef<any>(null);
  const registerMutation = useRegisterPushNotifications();
  const { isAuthenticated } = useAuthContext();

  useEffect(() => {
    if (!isAuthenticated || !Notifications || !Device) return;

    // Register for push notifications
    registerForPushNotificationsAsync().then((token) => {
      if (token) {
        registerMutation.mutate(token);
      }
    }).catch((err) => {
      console.warn('Push notification registration failed:', err);
    });

    // Handle notifications received while app is foregrounded
    if (Notifications && Notifications.addNotificationReceivedListener) {
      notificationListener.current = Notifications.addNotificationReceivedListener((notification: any) => {
        console.log('📱 Notification received:', notification);
      });
    }

    // Handle notification taps
    if (Notifications && Notifications.addNotificationResponseReceivedListener) {
      responseListener.current = Notifications.addNotificationResponseReceivedListener((response: any) => {
        console.log('📱 Notification tapped:', response);
        const data = response.notification.request.content.data;
        
        // Navigate to thread if available
        if (data?.thread_id) {
          // Navigation will be handled by the app's navigation system
          console.log('Navigate to thread:', data.thread_id);
        }
      });
    }

    return () => {
      if (notificationListener.current?.remove) {
        notificationListener.current.remove();
      }
      if (responseListener.current?.remove) {
        responseListener.current.remove();
      }
    };
  }, [isAuthenticated, registerMutation]);

  async function registerForPushNotificationsAsync(): Promise<string | null> {
    if (!Notifications || !Device) {
      console.warn('expo-notifications or expo-device not available');
      return null;
    }

    let token: string | null = null;

    if (Platform.OS === 'android' && Notifications.setNotificationChannelAsync) {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      });
    }

    if (Device.isDevice) {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        console.warn('Failed to get push token for push notification!');
        return null;
      }

      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: process.env.EXPO_PUBLIC_PROJECT_ID || undefined,
      });
      token = tokenData.data;
    } else {
      console.warn('Must use physical device for Push Notifications');
    }

    return token;
  }
}