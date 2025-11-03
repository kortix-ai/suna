'use client';

import { createMutationHook, createQueryHook } from '@/hooks/use-query';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getNotifications,
  markNotificationAsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
  registerPushToken,
  type Notification,
  type NotificationListResponse,
  type NotificationPreferences,
} from '@/lib/api';
import { notificationKeys } from './keys';

export const useNotifications = (
  params?: {
    page?: number;
    page_size?: number;
    is_read?: boolean;
    category?: string;
    notification_type?: string;
  }
) => {
  return createQueryHook(
    notificationKeys.list(params),
    () => getNotifications(params),
    {
      staleTime: 30 * 1000,
      refetchOnWindowFocus: true,
      refetchInterval: 60 * 1000, // Refetch every minute
    }
  )();
};

export const useNotificationPreferences = () => {
  return createQueryHook(
    notificationKeys.preferences(),
    getNotificationPreferences,
    {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  )();
};

export const useMarkNotificationAsRead = () => {
  const queryClient = useQueryClient();

  return createMutationHook(
    ({ notificationIds, isRead = true }: { notificationIds: string[]; isRead?: boolean }) =>
      markNotificationAsRead(notificationIds, isRead),
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: notificationKeys.lists() });
      },
    }
  )();
};

export const useUpdateNotificationPreferences = () => {
  const queryClient = useQueryClient();

  return createMutationHook(
    (preferences: Partial<{
      email_enabled: boolean;
      push_enabled: boolean;
      email_categories: Record<string, boolean>;
      push_categories: Record<string, boolean>;
    }>) => updateNotificationPreferences(preferences),
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: notificationKeys.preferences() });
        toast.success('Notification preferences updated');
      },
      onError: (error) => {
        toast.error('Failed to update preferences');
        console.error('Error updating preferences:', error);
      },
    }
  )();
};

export const useRegisterPushToken = () => {
  return createMutationHook(
    (pushToken: string) => registerPushToken(pushToken),
    {
      onSuccess: () => {
        // Invalidate preferences to refresh push token status
      },
      onError: (error) => {
        console.error('Error registering push token:', error);
      },
    }
  )();
};
