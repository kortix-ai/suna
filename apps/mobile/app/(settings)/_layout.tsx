import * as React from 'react';
import { useRouter } from 'expo-router';
import { Platform, BackHandler } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useFocusEffect } from 'expo-router/react-navigation';
import { SettingsHeader } from '@/components/kortix/settings-list';
import { AppStack, usePushTransition } from '@/components/navigation/stack-transitions';
import { useLanguage } from '@/contexts';
import { THEME } from '@/lib/utils/theme';

export default function SettingsLayout() {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const pushTransition = usePushTransition();

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

  // Closest THEME tokens to the settings stack's grouped-list background
  // (light uses --muted, L=96.1%; dark uses --surface, L=7.8% — nearest achromatic match).
  const backgroundColor = colorScheme === 'dark' ? THEME.dark.surface : THEME.light.muted;

  return (
    <AppStack
      screenOptions={{
        headerShown: false, // We use custom headers
        presentation: 'card',
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        contentStyle: {
          backgroundColor,
        },
        // Same push/pop as every stack (components/navigation/stack-transitions).
        ...pushTransition,
      }}
    >
      {/* No index screen: the Account page (Account tab, or /account-settings
          from a project) is the one settings page and pushes these sub-pages. */}
      <AppStack.Screen
        name="name"
        options={{
          header: () => <SettingsHeader title={t('nameEdit.title')} />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="language"
        options={{
          header: () => <SettingsHeader title={t('language.title')} />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="theme"
        options={{
          header: () => <SettingsHeader title={t('theme.title')} />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="sounds"
        options={{
          header: () => <SettingsHeader title="Sounds" />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="notifications"
        options={{
          header: () => <SettingsHeader title={t('notifications.title', 'Notifications')} />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="transactions"
        options={{
          header: () => <SettingsHeader title="Transactions" />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="instances"
        options={{
          header: () => <SettingsHeader title="Instances" />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="changelog"
        options={{
          header: () => <SettingsHeader title="Updates" />,
          headerShown: true,
        }}
      />
      <AppStack.Screen
        name="account-deletion"
        options={{
          header: () => <SettingsHeader title={t('accountDeletion.title')} />,
          headerShown: true,
        }}
      />
    </AppStack>
  );
}
