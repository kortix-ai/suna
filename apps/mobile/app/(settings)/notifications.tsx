import * as React from 'react';
import { Linking, View } from 'react-native';
import { INBOX_NOTIFICATION_KINDS, type InboxNotificationKind } from '@kortix/sdk';
import { useNotificationPreferences } from '@kortix/sdk/react';
import {
  ArrowCounterClockwiseIcon,
  BellIcon,
  ChatCircleIcon,
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
import { Switch } from '@/components/kortix/switch';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { KIND_LABEL } from '@/lib/notifications/inbox';
import { DEVICE_KIND_SWITCH } from '@/lib/notifications/push';
import { carryOverLegacyKinds } from '@/lib/notifications/registration';
import { useNotificationStore, type NotificationPreferences } from '@/stores/notification-store';

const KIND_ICON: Record<InboxNotificationKind, AppIcon> = {
  turn_done: CheckCircleIcon,
  turn_error: WarningIcon,
  question: QuestionIcon,
  permission: ShieldCheckIcon,
  shared: ShareNetworkIcon,
  automation_failed: XCircleIcon,
  automation_recovered: ArrowCounterClockwiseIcon,
  capture_device_down: XCircleIcon,
  capture_device_recovered: ArrowCounterClockwiseIcon,
  // Retired with Rooms (2026-11); the SDK type still carries the kind.
  message: ChatCircleIcon,
};

/**
 * Settings → Notifications (KRTX-1742; on for every project since 2026-11-06).
 *
 * - General: this phone's off switch and its sound. They stay on this phone
 *   and reach the server with its push token (PushNotificationsBridge).
 * - Push: one switch per kind, from the user's record on the server. It
 *   applies on every phone and browser. A session kind also has this phone's
 *   switch: the row shows on only when both are on, and a toggle writes both.
 * - No Email switches: email is edited on the web (KRTX-38). By default email
 *   is off for a kind until the person turns it on, except `automation_failed`
 *   and `capture_device_down` (`packages/shared/src/notification-kinds.ts`).
 *
 * The page shows no registration state (Jay, 2026-09-27): a token is
 * plumbing, not a setting.
 */
export default function NotificationsScreen() {
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

  const kinds = record.data?.kinds;
  // The kinds that cannot reach this person now: the API lists them, and the row is hidden.
  const hiddenKinds = record.data?.hidden_kinds ?? [];

  return (
    <SettingsPage>
      <GeneralRows
        preferences={preferences}
        onToggleEnabled={handleToggleEnabled}
        onTogglePlaySound={handleToggleSound}
      />

      {preferences.enabled &&
        (kinds ? (
          <SettingsGroup title="Push">
            {INBOX_NOTIFICATION_KINDS.filter((kind) => !hiddenKinds.includes(kind)).map((kind) => {
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

/** The General group: this phone's off switch and its sound (the sound rides
 * under the master switch: the only per-device behavior). The write goes
 * through the page's own store handle. */
function GeneralRows({
  preferences,
  onToggleEnabled,
  onTogglePlaySound,
}: {
  preferences: NotificationPreferences;
  onToggleEnabled: () => void;
  onTogglePlaySound: (playSound: boolean) => void;
}) {
  return (
    <SettingsGroup title="General">
      <SettingsRow
        icon={BellIcon}
        label="Notifications"
        right={<Switch checked={preferences.enabled} onCheckedChange={onToggleEnabled} />}
      />
      {preferences.enabled && (
        <SettingsRow
          icon={SpeakerHighIcon}
          label="Play sound"
          right={<Switch checked={preferences.playSound} onCheckedChange={onTogglePlaySound} />}
        />
      )}
    </SettingsGroup>
  );
}

/** The "This device" row: the OS notification settings, outside the app. */
const openDeviceSettings = () => {
  haptics.tap();
  void Linking.openSettings();
};
