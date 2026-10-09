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
import { useNotificationStore } from '@/stores/notification-store';

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
 * Settings → Notifications.
 *
 * - General: this phone's off switch and its sound. They stay on this phone
 *   and reach the server with its push token (PushNotificationsBridge).
 * - Push: one switch per kind, from the user's record on the server
 *   (KRTX-1742). It applies on every phone and browser. Email is edited on
 *   the web: mobile keeps the core set (KRTX-38).
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

  // Optimistic: the switch moves at once and moves back if the save fails.
  const update = record.update;
  const handleTogglePush = React.useCallback(
    (kind: InboxNotificationKind, push: boolean) => {
      haptics.selection();
      update({ kinds: { [kind]: { push } } }).catch(() => toast.error('Unable to save the setting. Try again.'));
    },
    [update, toast]
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
            {INBOX_NOTIFICATION_KINDS.map((kind) => (
              <SettingsRow
                key={kind}
                icon={KIND_ICON[kind]}
                label={KIND_LABEL[kind]}
                right={
                  <Switch
                    checked={kinds[kind]?.push ?? true}
                    onCheckedChange={(push) => handleTogglePush(kind, push)}
                    accessibilityLabel={KIND_LABEL[kind]}
                  />
                }
              />
            ))}
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
