'use client';

import React from 'react';
import { AdminNotificationForm } from '@/components/admin/admin-notification-form';
import { AdminNotificationBatchList } from '@/components/admin/admin-notification-batch-list';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Send, History } from 'lucide-react';

export default function AdminNotificationsPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20">
      <div className="max-w-6xl mx-auto p-6 space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notification Management</h1>
          <p className="text-muted-foreground mt-2">
            Send global notifications to users and manage notification batches
          </p>
        </div>

        <Tabs defaultValue="send" className="space-y-6">
          <TabsList>
            <TabsTrigger value="send">
              <Send className="h-4 w-4 mr-2" />
              Send Notification
            </TabsTrigger>
            <TabsTrigger value="history">
              <History className="h-4 w-4 mr-2" />
              Batch History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="send" className="space-y-6">
            <AdminNotificationForm />
          </TabsContent>

          <TabsContent value="history" className="space-y-6">
            <AdminNotificationBatchList />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

