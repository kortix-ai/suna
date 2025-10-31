'use client';

import React from 'react';
import { useNotifications, useMarkNotificationAsRead } from '@/hooks/react-query/notifications/use-notifications';
import { NotificationItem } from './notification-item';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

export function NotificationList() {
  const { data, isLoading } = useNotifications({ page: 1, page_size: 20 });
  const markAsRead = useMarkNotificationAsRead();

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading notifications...
      </div>
    );
  }

  const notifications = data?.notifications || [];

  if (notifications.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No notifications
      </div>
    );
  }

  const unreadNotifications = notifications.filter(n => !n.is_read);

  const handleMarkAllAsRead = () => {
    if (unreadNotifications.length > 0) {
      markAsRead.mutate({
        notificationIds: unreadNotifications.map(n => n.id),
      });
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-semibold text-sm">Notifications</h3>
        {unreadNotifications.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleMarkAllAsRead}
            className="text-xs"
          >
            Mark all as read
          </Button>
        )}
      </div>
      <ScrollArea className="h-[400px]">
        <div className="divide-y">
          {notifications.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
