import * as React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Platform, BackHandler } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useFocusEffect } from 'expo-router/react-navigation';
import { SettingsHeader } from '@/components/kortix/settings-list';
import { useLanguage } from '@/contexts';
import { THEME } from '@/lib/utils/theme';

export default function SettingsLayout() {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const router = useRouter();

  useFocusEffect(
    React.useCallback(() => {
      if (Platform.OS !== 'android') return undefined;

      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/');
        }
        return true;
      });

      return () => subscription.remove();
    }, [router]),
  );

  // Every settings page and SettingsHeader paint `bg-background`; the stack
  // content behind them uses the same token so a transition shows no other colour.
  const backgroundColor = colorScheme === 'dark' ? THEME.dark.background : THEME.light.background;

  return (
    <Stack
      screenOptions={{
        headerShown: false, // We use custom headers
        presentation: 'card',
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        contentStyle: {
          backgroundColor,
        },
      }}
    >
      {/* No index screen: the Account page (Account tab, or /projects/[id]/account
          from a project) is the one settings page and pushes these sub-pages. */}
      <Stack.Screen
        name="language"
        options={{
          header: () => <SettingsHeader title={t('language.title')} />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="sounds"
        options={{
          header: () => <SettingsHeader title="Sounds" />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="notifications"
        options={{
          header: () => <SettingsHeader title={t('notifications.title', 'Notifications')} />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="instances"
        options={{
          header: () => <SettingsHeader title="Instances" />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="account-deletion"
        options={{
          header: () => <SettingsHeader title={t('accountDeletion.title')} />,
          headerShown: true,
        }}
      />
    </Stack>
  );
}
