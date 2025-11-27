'use client';

import React, { useState, useEffect } from 'react';
import { Bell, Mail, Smartphone, MessageSquare, CreditCard, Star, Settings as SettingsIcon } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { notificationAPI, type NotificationSettings } from '@/lib/api/notifications';
import { isStagingMode } from '@/lib/config';

export function NotificationSettingsPanel() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isStagingMode()) {
      loadSettings();
    } else {
      setLoading(false);
    }
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const data = await notificationAPI.getSettings();
      setSettings(data);
    } catch (error) {
      console.error('Failed to load notification settings:', error);
      toast.error('Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  };

  const updateSetting = async (key: keyof NotificationSettings, value: boolean) => {
    if (!settings) return;

    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);

    try {
      setSaving(true);
      await notificationAPI.updateSettings({ [key]: value });
      toast.success('Settings updated');
    } catch (error) {
      console.error('Failed to update settings:', error);
      toast.error('Failed to update settings');
      setSettings(settings);
    } finally {
      setSaving(false);
    }
  };

  const testNotification = async () => {
    try {
      await notificationAPI.sendTestNotification(
        'Test Notification',
        'This is a test notification from Kortix. If you see this, your notifications are working!'
      );
      toast.success('Test notification sent!');
    } catch (error) {
      console.error('Failed to send test notification:', error);
      toast.error('Failed to send test notification');
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Notification Settings</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Notification Settings</CardTitle>
          <CardDescription>Failed to load settings</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Notification Channels
          </CardTitle>
          <CardDescription>
            Choose how you want to receive notifications
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Mail className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="email-enabled" className="font-medium">
                  Email Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive notifications via email
                </p>
              </div>
            </div>
            <Switch
              id="email-enabled"
              checked={settings.email_enabled}
              onCheckedChange={(checked) => updateSetting('email_enabled', checked)}
              disabled={saving}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="in-app-enabled" className="font-medium">
                  In-App Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  See notifications in the app
                </p>
              </div>
            </div>
            <Switch
              id="in-app-enabled"
              checked={settings.in_app_enabled}
              onCheckedChange={(checked) => updateSetting('in_app_enabled', checked)}
              disabled={saving}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Smartphone className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="push-enabled" className="font-medium">
                  Push Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive push notifications on your devices
                </p>
              </div>
            </div>
            <Switch
              id="push-enabled"
              checked={settings.push_enabled}
              onCheckedChange={(checked) => updateSetting('push_enabled', checked)}
              disabled={saving}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" />
            Notification Types
          </CardTitle>
          <CardDescription>
            Control which types of notifications you receive
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="task-notifications" className="font-medium">
                  Task Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Task completions, failures, and updates
                </p>
              </div>
            </div>
            <Switch
              id="task-notifications"
              checked={settings.task_notifications}
              onCheckedChange={(checked) => updateSetting('task_notifications', checked)}
              disabled={saving}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="billing-notifications" className="font-medium">
                  Billing Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Payments, subscriptions, and credits
                </p>
              </div>
            </div>
            <Switch
              id="billing-notifications"
              checked={settings.billing_notifications}
              onCheckedChange={(checked) => updateSetting('billing_notifications', checked)}
              disabled={saving}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Star className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="promotional-notifications" className="font-medium">
                  Promotional Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  New features, tips, and special offers
                </p>
              </div>
            </div>
            <Switch
              id="promotional-notifications"
              checked={settings.promotional_notifications}
              onCheckedChange={(checked) => updateSetting('promotional_notifications', checked)}
              disabled={saving}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="system-notifications" className="font-medium">
                  System Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Important system updates and alerts
                </p>
              </div>
            </div>
            <Switch
              id="system-notifications"
              checked={settings.system_notifications}
              onCheckedChange={(checked) => updateSetting('system_notifications', checked)}
              disabled={saving}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test Notifications</CardTitle>
          <CardDescription>
            Send a test notification to verify your settings
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={testNotification} variant="outline">
            Send Test Notification
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

