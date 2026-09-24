import * as React from 'react';
import { Linking } from 'react-native';
import {
  WarningIcon as AlertTriangle,
  BellIcon as Bell,
  BellSlashIcon as BellOff,
  CheckCircleIcon as CheckCircle2,
  QuestionIcon as HelpCircle,
  SlidersHorizontalIcon as Settings2,
  ShieldCheckIcon as ShieldCheck,
  DeviceMobileIcon as Smartphone,
  SpeakerHighIcon as Volume2,
} from '@/lib/icons';

import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { haptics } from '@/lib/haptics';
import { notificationsApi } from '@/lib/notifications/api';
import { useNotificationStore, type NotificationPreferences } from '@/stores/notification-store';

type ToggleKey = 'onCompletion' | 'onError' | 'onQuestion' | 'onPermission' | 'playSound';

const NOTIFICATION_TYPES: { key: ToggleKey; label: string; icon: typeof Bell }[] = [
  { key: 'onCompletion', label: 'Task completions', icon: CheckCircle2 },
  { key: 'onError', label: 'Errors', icon: AlertTriangle },
  { key: 'onQuestion', label: 'Questions', icon: HelpCircle },
  { key: 'onPermission', label: 'Permission requests', icon: ShieldCheck },
];

export default function NotificationsScreen() {
  const { expoPushToken } = usePushNotifications();
  const toast = useToast();
  const [isUnregistering, setIsUnregistering] = React.useState(false);

  const preferences = useNotificationStore((s) => s.preferences);
  const setPreference = useNotificationStore((s) => s.setPreference);
  const toggleEnabled = useNotificationStore((s) => s.toggleEnabled);

  const handleToggleEnabled = React.useCallback(() => {
    haptics.selection();
    toggleEnabled();
  }, [toggleEnabled]);

  const handleToggle = React.useCallback(
    <K extends keyof NotificationPreferences>(key: K, value: NotificationPreferences[K]) => {
      haptics.selection();
      setPreference(key, value);
    },
    [setPreference]
  );

  const handleUnregister = React.useCallback(async () => {
    if (!expoPushToken || isUnregistering) return;
    haptics.medium();
    setIsUnregistering(true);
    try {
      await notificationsApi.unregisterDeviceToken(expoPushToken);
      haptics.success();
      toast.success('Device unregistered', {
        description: 'This device no longer receives push notifications.',
      });
    } catch (error: any) {
      haptics.warning();
      toast.error('Unable to unregister', { description: error?.message || 'Try again in a moment.' });
    } finally {
      setIsUnregistering(false);
    }
  }, [expoPushToken, isUnregistering, toast]);

  const openDeviceSettings = React.useCallback(() => {
    haptics.tap();
    void Linking.openSettings();
  }, []);

  return (
    <SettingsPage>
      <SettingsGroup title="General">
        <SettingsRow
          icon={Bell}
          label="Notifications"
          right={<Switch checked={preferences.enabled} onCheckedChange={handleToggleEnabled} />}
        />
      </SettingsGroup>

      {preferences.enabled && (
        <SettingsGroup title="Notification types">
          {NOTIFICATION_TYPES.map((type) => (
            <SettingsRow
              key={type.key}
              icon={type.icon}
              label={type.label}
              right={
                <Switch
                  checked={preferences[type.key]}
                  onCheckedChange={(v) => handleToggle(type.key, v)}
                />
              }
            />
          ))}
        </SettingsGroup>
      )}

      {preferences.enabled && (
        <SettingsGroup title="Behavior">
          <SettingsRow
            icon={Volume2}
            label="Notification sound"
            right={
              <Switch
                checked={preferences.playSound}
                onCheckedChange={(v) => handleToggle('playSound', v)}
              />
            }
          />
        </SettingsGroup>
      )}

      <SettingsGroup title="This device">
        <SettingsRow
          icon={Smartphone}
          label="Push notifications"
          value={expoPushToken ? 'Registered' : 'Not registered'}
        />
        <SettingsRow icon={Settings2} label="Device settings" external onPress={openDeviceSettings} />
        {!!expoPushToken && (
          <SettingsRow
            icon={BellOff}
            label={isUnregistering ? 'Unregistering…' : 'Unregister device'}
            destructive
            onPress={isUnregistering ? undefined : handleUnregister}
          />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
