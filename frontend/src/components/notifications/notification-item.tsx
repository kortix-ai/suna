'use client';

import React from 'react';
import { CheckCircle2, Info, AlertCircle, XCircle, CheckCheck } from 'lucide-react';
import { useMarkNotificationAsRead } from '@/hooks/react-query/notifications/use-notifications';
import type { Notification } from '@/lib/api';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

interface NotificationItemProps {
  notification: Notification;
}

const typeIcons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
  agent_complete: CheckCheck,
};

const typeColors = {
  info: 'text-blue-500',
  success: 'text-green-500',
  warning: 'text-yellow-500',
  error: 'text-red-500',
  agent_complete: 'text-purple-500',
};

export function NotificationItem({ notification }: NotificationItemProps) {
  const markAsRead = useMarkNotificationAsRead();
  const Icon = typeIcons[notification.type] || Info;

  const handleClick = () => {
    if (!notification.is_read) {
      markAsRead.mutate({ notificationIds: [notification.id] });
    }
  };

  return (
    <div
      className={cn(
        'p-4 cursor-pointer hover:bg-muted/50 transition-colors',
        !notification.is_read && 'bg-muted/30'
      )}
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn('h-5 w-5 mt-0.5 flex-shrink-0', typeColors[notification.type])} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium text-sm">{notification.title}</p>
            {!notification.is_read && (
              <div className="h-2 w-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" />
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{notification.message}</p>
          <p className="text-xs text-muted-foreground mt-2">
            {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
          </p>
        </div>
      </div>
    </div>
  );
}
