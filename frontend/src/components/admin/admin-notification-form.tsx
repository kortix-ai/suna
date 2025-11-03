'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSendGlobalNotification } from '@/hooks/react-query/admin/use-admin-notifications';
import { Loader2, Send } from 'lucide-react';
import type { GlobalNotificationRequest } from '@/lib/api';

export function AdminNotificationForm() {
  const [formData, setFormData] = useState<GlobalNotificationRequest>({
    title: '',
    message: '',
    notification_type: 'info',
    send_email: true,
    send_push: true,
    target_account_ids: undefined,
    target_user_ids: undefined,
  });

  const sendMutation = useSendGlobalNotification();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title.trim() || !formData.message.trim()) {
      return;
    }

    sendMutation.mutate(
      {
        title: formData.title.trim(),
        message: formData.message.trim(),
        notification_type: formData.notification_type,
        send_email: formData.send_email,
        send_push: formData.send_push,
        target_account_ids: formData.target_account_ids?.length
          ? formData.target_account_ids
          : undefined,
        target_user_ids: formData.target_user_ids?.length ? formData.target_user_ids : undefined,
      },
      {
        onSuccess: () => {
          // Reset form after successful submission
          setFormData({
            title: '',
            message: '',
            notification_type: 'info',
            send_email: true,
            send_push: true,
            target_account_ids: undefined,
            target_user_ids: undefined,
          });
        },
      }
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send Global Notification</CardTitle>
        <CardDescription>
          Send a notification to all users or specific target users via email and/or push
          notification. Notifications are sent immediately via background task after submission.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder="Notification title"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">Message *</Label>
            <Textarea
              id="message"
              value={formData.message}
              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
              placeholder="Notification message"
              rows={6}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="type">Notification Type</Label>
            <Select
              value={formData.notification_type}
              onValueChange={(value: 'info' | 'success' | 'warning' | 'error') =>
                setFormData({ ...formData, notification_type: value })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="send_email"
                checked={formData.send_email}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, send_email: checked === true })
                }
              />
              <Label htmlFor="send_email" className="font-normal cursor-pointer">
                Send Email Notification
              </Label>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="send_push"
                checked={formData.send_push}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, send_push: checked === true })
                }
              />
              <Label htmlFor="send_push" className="font-normal cursor-pointer">
                Send Push Notification
              </Label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target_account_ids">
              Target Account IDs (optional, comma-separated)
            </Label>
            <Input
              id="target_account_ids"
              value={formData.target_account_ids?.join(',') || ''}
              onChange={(e) => {
                const value = e.target.value.trim();
                setFormData({
                  ...formData,
                  target_account_ids: value
                    ? value.split(',').map((id) => id.trim()).filter(Boolean)
                    : undefined,
                });
              }}
              placeholder="Leave empty to send to all users"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to send to all users. Enter comma-separated account IDs to target
              specific accounts.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target_user_ids">Target User IDs (optional, comma-separated)</Label>
            <Input
              id="target_user_ids"
              value={formData.target_user_ids?.join(',') || ''}
              onChange={(e) => {
                const value = e.target.value.trim();
                setFormData({
                  ...formData,
                  target_user_ids: value
                    ? value.split(',').map((id) => id.trim()).filter(Boolean)
                    : undefined,
                });
              }}
              placeholder="Leave empty to send to all users"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to send to all users. Enter comma-separated user IDs to target specific
              users.
            </p>
          </div>

          <div className="space-y-3">
            <Button type="submit" disabled={sendMutation.isPending} className="w-full">
              {sendMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Queuing...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Send Notification
                </>
              )}
            </Button>
            {sendMutation.isSuccess && (
              <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                  ✅ Notification queued successfully
                </p>
                <p className="text-xs text-green-600/80 dark:text-green-400/80 mt-1">
                  Sending will begin immediately in the background. You can track progress in the Batch History tab.
                </p>
              </div>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

