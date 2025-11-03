'use client';

import React from 'react';
import { NotificationList } from '@/components/notifications/notification-list';

export default function NotificationsPage() {
  return (
    <div className="container mx-auto py-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Notifications</h1>
        <p className="text-muted-foreground mt-2">
          Manage your notifications and preferences
        </p>
      </div>
      
      <div className="bg-card rounded-lg border shadow-sm">
        <NotificationList />
      </div>
    </div>
  );
}
