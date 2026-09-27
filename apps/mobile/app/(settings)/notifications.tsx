import * as React from 'react';
import { Linking } from 'react-native';
import {
  WarningIcon as AlertTriangle,
  BellIcon as Bell,
  CheckCircleIcon as CheckCircle2,
  QuestionIcon as HelpCircle,
  SlidersHorizontalIcon as Settings2,
  ShieldCheckIcon as ShieldCheck,
  SpeakerHighIcon as Volume2,
} from '@/lib/icons';

import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import { useNotificationStore, type NotificationPreferences } from '@/stores/notification-store';

type ToggleKey = 'onCompletion' | 'onError' | 'onQuestion' | 'onPermission' | 'playSound';

const NOTIFICATION_TYPES: { key: ToggleKey; label: string; icon: typeof Bell }[] = [
  { key: 'onCompletion', label: 'Task completions', icon: CheckCircle2 },
  { key: 'onError', label: 'Errors', icon: AlertTriangle },
  { key: 'onQuestion', label: 'Questions', icon: HelpCircle },
  { key: 'onPermission', label: 'Permission requests', icon: ShieldCheck },
];

export default function NotificationsScreen() {
  // Registration is app-wide (components/notifications/PushNotificationsBridge);
  // preference changes reach the server from there. The master switch is
  // this device's off switch. The page shows no registration state (Jay,
  // 2026-09-27): a token is plumbing, not a setting.
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
        {/* Sound rides under the master switch: the only per-device behavior. */}
        {preferences.enabled && (
          <SettingsRow
            icon={Volume2}
            label="Play sound"
            right={
              <Switch
                checked={preferences.playSound}
                onCheckedChange={(v) => handleToggle('playSound', v)}
              />
            }
          />
        )}
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

      <SettingsGroup title="This device">
        <SettingsRow icon={Settings2} label="Device settings" external onPress={openDeviceSettings} />
      </SettingsGroup>
    </SettingsPage>
  );
}
