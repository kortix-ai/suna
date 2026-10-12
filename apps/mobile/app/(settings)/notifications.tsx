import * as React from 'react';
import { Linking, View } from 'react-native';
import { INBOX_NOTIFICATION_KINDS, type InboxNotificationKind } from '@kortix/sdk';
import { useNotificationPreferences } from '@kortix/sdk/react';
import {
  ArrowCounterClockwiseIcon,
  BellIcon,
  CheckCircleIcon,
  QuestionIcon,
  ShareNetworkIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SpeakerHighIcon,
  WarningIcon,
  XCircleIcon,
  type AppIcon,
} from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { KIND_LABEL } from '@/lib/notifications/inbox';
import { DEVICE_KIND_SWITCH } from '@/lib/notifications/push';
import { carryOverLegacyKinds } from '@/lib/notifications/registration';
import { useHasNotificationCenterProject } from '@/lib/projects/hooks';
import { useNotificationStore, type NotificationPreferences } from '@/stores/notification-store';

type ToggleKey = 'onCompletion' | 'onError' | 'onQuestion' | 'onPermission' | 'playSound';

const NOTIFICATION_TYPES: { key: ToggleKey; label: string; icon: AppIcon }[] = [
  { key: 'onCompletion', label: 'Task completions', icon: CheckCircleIcon },
  { key: 'onError', label: 'Errors', icon: WarningIcon },
  { key: 'onQuestion', label: 'Questions', icon: QuestionIcon },
  { key: 'onPermission', label: 'Permission requests', icon: ShieldCheckIcon },
];

const KIND_ICON: Record<InboxNotificationKind, AppIcon> = {
  turn_done: CheckCircleIcon,
  turn_error: WarningIcon,
  question: QuestionIcon,
  permission: ShieldCheckIcon,
  shared: ShareNetworkIcon,
  automation_failed: XCircleIcon,
  automation_recovered: ArrowCounterClockwiseIcon,
};

/**
 * Settings → Notifications. KRTX-1742 is behind the per-project
 * `notification_center` flag, off by default. The page has two modes:
 *
 * - No project of this user has the flag on (or the lists still load): this
 *   phone's switches only (`DeviceNotificationsPage`), the page from before
 *   KRTX-1742.
 * - One or more projects have it on: the user's record on the server
 *   (`NotificationCenterPage`).
 */
export default function NotificationsScreen() {
  return useHasNotificationCenterProject() ? <NotificationCenterPage /> : <DeviceNotificationsPage />;
}

function DeviceNotificationsPage() {
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
          icon={BellIcon}
          label="Notifications"
          right={<Switch checked={preferences.enabled} onCheckedChange={handleToggleEnabled} />}
        />
        {/* Sound rides under the master switch: the only per-device behavior. */}
        {preferences.enabled && (
          <SettingsRow
            icon={SpeakerHighIcon}
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
        <SettingsRow icon={SlidersHorizontalIcon} label="Device settings" external onPress={openDeviceSettings} />
      </SettingsGroup>
    </SettingsPage>
  );
}

/**
 * - General: this phone's off switch and its sound. They stay on this phone
 *   and reach the server with its push token (PushNotificationsBridge).
 * - Push: one switch per kind, from the user's record on the server. It
 *   applies on every phone and browser. Email is edited on the web: mobile
 *   keeps the core set (KRTX-38). A session kind also has this phone's
 *   switch, which a project with the flag off reads alone: the row shows on
 *   only when both are on, and a toggle writes both.
 *
 * The page shows no registration state (Jay, 2026-09-27): a token is
 * plumbing, not a setting.
 */
function NotificationCenterPage() {
  const preferences = useNotificationStore((s) => s.preferences);
  const setPreference = useNotificationStore((s) => s.setPreference);
  const toggleEnabled = useNotificationStore((s) => s.toggleEnabled);
  const { user } = useAuthContext();
  const record = useNotificationPreferences({ userId: user?.id });
  const toast = useToast();

  React.useEffect(() => {
    void carryOverLegacyKinds();
  }, []);

  const handleToggleEnabled = React.useCallback(() => {
    haptics.selection();
    toggleEnabled();
  }, [toggleEnabled]);

  const handleToggleSound = React.useCallback(
    (playSound: boolean) => {
      haptics.selection();
      setPreference('playSound', playSound);
    },
    [setPreference]
  );

  // Optimistic: the record moves at once and moves back if the save fails.
  // This phone's switch keeps the new value: the row then shows what this
  // phone gets.
  const update = record.update;
  const handleTogglePush = React.useCallback(
    (kind: InboxNotificationKind, push: boolean) => {
      haptics.selection();
      const deviceKey = DEVICE_KIND_SWITCH[kind];
      if (deviceKey) setPreference(deviceKey, push);
      update({ kinds: { [kind]: { push } } }).catch(() => toast.error('Unable to save the setting. Try again.'));
    },
    [setPreference, update, toast]
  );

  const openDeviceSettings = React.useCallback(() => {
    haptics.tap();
    void Linking.openSettings();
  }, []);

  const kinds = record.data?.kinds;

  return (
    <SettingsPage>
      <SettingsGroup title="General">
        <SettingsRow
          icon={BellIcon}
          label="Notifications"
          right={<Switch checked={preferences.enabled} onCheckedChange={handleToggleEnabled} />}
        />
        {preferences.enabled && (
          <SettingsRow
            icon={SpeakerHighIcon}
            label="Play sound"
            right={<Switch checked={preferences.playSound} onCheckedChange={handleToggleSound} />}
          />
        )}
      </SettingsGroup>

      {preferences.enabled &&
        (kinds ? (
          <SettingsGroup title="Push">
            {INBOX_NOTIFICATION_KINDS.map((kind) => {
              const deviceKey = DEVICE_KIND_SWITCH[kind];
              const checked = (kinds[kind]?.push ?? true) && (!deviceKey || preferences[deviceKey]);
              return (
                <SettingsRow
                  key={kind}
                  icon={KIND_ICON[kind]}
                  label={KIND_LABEL[kind]}
                  right={
                    <Switch
                      checked={checked}
                      onCheckedChange={(push) => handleTogglePush(kind, push)}
                      accessibilityLabel={KIND_LABEL[kind]}
                    />
                  }
                />
              );
            })}
          </SettingsGroup>
        ) : (
          <View className="items-center gap-3 py-4">
            {record.isError ? (
              <>
                <Text variant="muted" className="text-center">
                  Unable to load your push settings.
                </Text>
                <Button variant="secondary" size="sm" className="rounded-full" onPress={() => void record.refetch()}>
                  <Text>Try again</Text>
                </Button>
              </>
            ) : (
              <KortixLoader />
            )}
          </View>
        ))}

      <SettingsGroup title="This device">
        <SettingsRow icon={SlidersHorizontalIcon} label="Device settings" external onPress={openDeviceSettings} />
      </SettingsGroup>
    </SettingsPage>
  );
}
