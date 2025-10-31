export const notificationKeys = {
  all: ['notifications'] as const,
  lists: () => [...notificationKeys.all, 'list'] as const,
  list: (params?: {
    page?: number;
    page_size?: number;
    is_read?: boolean;
    category?: string;
    notification_type?: string;
  }) => [...notificationKeys.lists(), params] as const,
  preferences: () => [...notificationKeys.all, 'preferences'] as const,
};
