import * as React from 'react';
import { Alert, Linking, Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { haptics } from '@/lib/haptics';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  HelpCircle,
  ShieldCheck,
  Smartphone,
  Volume2,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { notificationsApi } from '@/lib/notifications/api';
import { useNotificationStore, type NotificationPreferences } from '@/stores/notification-store';

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { expoPushToken } = usePushNotifications();
  const [isUnregistering, setIsUnregistering] = React.useState(false);

  const preferences = useNotificationStore((s) => s.preferences);
  const setPreference = useNotificationStore((s) => s.setPreference);
  const toggleEnabled = useNotificationStore((s) => s.toggleEnabled);

  const trackOff = isDark ? '#3A3A3C' : '#E5E7EB';

  const handleToggleEnabled = React.useCallback(() => {
    haptics.selection();
    toggleEnabled();
  }, [toggleEnabled]);

  const handleToggle = React.useCallback(<K extends keyof NotificationPreferences>(
    key: K,
    value: NotificationPreferences[K],
  ) => {
    haptics.selection();
    setPreference(key, value);
  }, [setPreference]);

  const handleUnregister = React.useCallback(async () => {
    if (!expoPushToken || isUnregistering) return;
    haptics.medium();
    setIsUnregistering(true);
    try {
      await notificationsApi.unregisterDeviceToken(expoPushToken);
      haptics.success();
      Alert.alert('Success', 'Device unregistered successfully');
    } catch (error: any) {
      haptics.warning();
      Alert.alert('Error', error?.message || 'Failed to unregister device');
    } finally {
      setIsUnregistering(false);
    }
  }, [expoPushToken, isUnregistering]);

  const openSettings = React.useCallback(() => {
    haptics.tap();
    Linking.openSettings();
  }, []);

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <View className="px-5 pt-1" style={{ gap: 18 }}>
        {/* Master Toggle */}
        <View className="px-1">
          <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
            General
          </Text>
          <View className="py-3.5">
            <View className="flex-row items-center">
              <Icon as={Bell} size={18} className="text-foreground/80" strokeWidth={2.2} />
              <View className="ml-4 flex-1">
                <Text className="font-roobert-medium text-[15px] text-foreground">
                  Enable Notifications
                </Text>
                <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                  Receive alerts for session events
                </Text>
              </View>
              <Switch
                value={preferences.enabled}
                onValueChange={handleToggleEnabled}
                trackColor={{ false: trackOff, true: '#34C759' }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={trackOff}
              />
            </View>
          </View>
        </View>

        {/* Notification Types */}
        {preferences.enabled && (
          <View className="px-1">
            <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
              Notification Types
            </Text>
            <View>
              <ToggleRow
                icon={CheckCircle2}
                title="Task Completions"
                description="When a session finishes its task"
                value={preferences.onCompletion}
                onValueChange={(v) => handleToggle('onCompletion', v)}
                trackOff={trackOff}
                showDivider
              />
              <ToggleRow
                icon={AlertTriangle}
                title="Errors"
                description="When a session encounters an error"
                value={preferences.onError}
                onValueChange={(v) => handleToggle('onError', v)}
                trackOff={trackOff}
                showDivider
              />
              <ToggleRow
                icon={HelpCircle}
                title="Questions"
                description="When Kortix needs your input to continue"
                value={preferences.onQuestion}
                onValueChange={(v) => handleToggle('onQuestion', v)}
                trackOff={trackOff}
                showDivider
              />
              <ToggleRow
                icon={ShieldCheck}
                title="Permission Requests"
                description="When Kortix needs permission to use a tool"
                value={preferences.onPermission}
                onValueChange={(v) => handleToggle('onPermission', v)}
                trackOff={trackOff}
              />
            </View>
          </View>
        )}

        {/* Behavior */}
        {preferences.enabled && (
          <View className="px-1">
            <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
              Behavior
            </Text>
            <View>
              <ToggleRow
                icon={Volume2}
                title="Notification Sound"
                description="Play a sound when a notification is sent"
                value={preferences.playSound}
                onValueChange={(v) => handleToggle('playSound', v)}
                trackOff={trackOff}
              />
            </View>
          </View>
        )}

        {/* Push Notifications */}
        <View className="px-1">
          <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
            Push Notifications
          </Text>
          <View>
            <View className="py-3.5">
              <View className="flex-row items-center">
                <Icon as={Smartphone} size={18} className="text-foreground/80" strokeWidth={2.2} />
                <View className="ml-4 flex-1">
                  <Text className="font-roobert-medium text-[15px] text-foreground">
                    Device Status
                  </Text>
                  <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                    {expoPushToken
                      ? 'This device is registered for push notifications'
                      : 'Enable notifications in your device settings'}
                  </Text>
                </View>
                <Icon as={ChevronRight} size={16} className="text-muted-foreground/50" strokeWidth={2.2} />
              </View>
            </View>
            <View className="h-px bg-border/35" />
            <View className="flex-row py-3.5" style={{ gap: 10 }}>
              <Pressable
                onPress={openSettings}
                className="rounded-lg bg-muted/60 px-3 py-2 active:opacity-80"
              >
                <Text className="font-roobert-medium text-xs text-foreground">
                  Open Settings
                </Text>
              </Pressable>
              {!!expoPushToken && (
                <Pressable
                  onPress={handleUnregister}
                  disabled={isUnregistering}
                  className="rounded-lg bg-destructive/10 px-3 py-2 active:opacity-80"
                >
                  <Text className="font-roobert-medium text-xs text-destructive">
                    {isUnregistering ? 'Unregistering...' : 'Unregister Device'}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

function ToggleRow({
  icon,
  title,
  description,
  value,
  onValueChange,
  trackOff,
  showDivider = false,
}: {
  icon: typeof Bell;
  title: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  trackOff: string;
  showDivider?: boolean;
}) {
  return (
    <>
      <View className="py-3.5">
        <View className="flex-row items-center">
          <Icon as={icon} size={18} className="text-foreground/80" strokeWidth={2.2} />
          <View className="ml-4 flex-1">
            <Text className="font-roobert-medium text-[15px] text-foreground">{title}</Text>
            <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">{description}</Text>
          </View>
          <Switch
            value={value}
            onValueChange={onValueChange}
            trackColor={{ false: trackOff, true: '#34C759' }}
            thumbColor="#FFFFFF"
            ios_backgroundColor={trackOff}
          />
        </View>
      </View>
      {showDivider && <View className="h-px bg-border/35" />}
    </>
  );
}
